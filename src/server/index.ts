import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllLeads, insertLeads, deleteLeads, getLeadById, getLeadByMapsUrl, saveReviews, getReviews, saveDetails, markReviewScrape, enqueueSmsBatch, getSmsQueue, markSmsQueueItem, clearSmsQueue, saveWebsiteData, logOutreach } from '../leads/repository.js';
import { scrapeWebsite } from '../scraper/website-scraper.js';
import { submitContactForm } from '../scraper/form-submitter.js';
import { getDb } from '../leads/db.js';
import { scrapeZip } from '../scraper/map-scraper.js';
import { sendSms } from '../outreach/sms.js';
import { scrapeReviews } from '../scraper/review-scraper.js';
import { scrapeDetails } from '../scraper/detail-scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env['PORT'] ?? 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE broadcast ────────────────────────────────────────────────────────────
const sseClients = new Set<express.Response>();

type LogSource = 'main' | 'detail' | 'website' | 'reviews';

function broadcast(data: object, source: LogSource = 'main'): void {
  const msg = `data: ${JSON.stringify({ ...data, source })}\n\n`;
  sseClients.forEach((res) => res.write(msg));
}

app.get('/api/scrape/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Scrape control ───────────────────────────────────────────────────────────
let scraping = false;
let shouldStop = false;
let stopping = false;
let activeScrapeController: AbortController | null = null;

app.get('/api/scrape/status', (_req, res) => {
  res.json({ scraping, stopping });
});

app.post('/api/scrape/start', (req, res) => {
  if (scraping) {
    res.status(409).json({ error: 'Scrape already running' });
    return;
  }

  const { zips, categories, maxPerZip = 500, workers = 1, skipScraped = false, detailFirst = false } = req.body as {
    zips: string[]; categories: string[]; maxPerZip: number; workers?: number; skipScraped?: boolean; detailFirst?: boolean;
  };
  const cappedMaxPerZip = Math.min(Math.max(Number(maxPerZip) || 500, 1), 500);
  const cappedWorkers = Math.min(Math.max(Number(workers) || 1, 1), 10);

  if (!zips?.length || !categories?.length) {
    res.status(400).json({ error: 'zips and categories required' });
    return;
  }

  let jobs: { zip: string; category: string }[] = [];
  for (const zip of zips) for (const category of categories) jobs.push({ zip, category });

  if (skipScraped) {
    const done = new Set(
      (getDb().prepare('SELECT DISTINCT zip, category FROM leads').all() as { zip: string; category: string }[])
        .map((r) => `${r.zip}::${r.category.toLowerCase()}`)
    );
    const before = jobs.length;
    jobs = jobs.filter((j) => !done.has(`${j.zip}::${j.category.toLowerCase()}`));
    const skipped = before - jobs.length;
    if (skipped > 0 && jobs.length === 0) {
      res.json({ started: false, skipped, jobs: 0, message: 'All selected zips already scraped.' });
      return;
    }
  }

  res.json({ started: true, jobs: jobs.length });

  void (async () => {
    scraping = true;
    shouldStop = false;
    stopping = false;
    activeScrapeController = new AbortController();
    broadcast({ type: 'start', message: `Starting ${jobs.length} job(s) with ${cappedWorkers} worker(s)` });

    let nextJob = 0;
    const runWorker = async (workerId: number) => {
      while (!shouldStop) {
        const job = jobs[nextJob++];
        if (!job) break;
        const { zip, category } = job;

        broadcast({ type: 'log', message: `Worker ${workerId}: scraping "${category}" near ${zip}...` });

        const signal = activeScrapeController?.signal;
        if (!signal || signal.aborted) break;

        try {
          const { leads, detailsMap } = await scrapeZip(zip, category, cappedMaxPerZip, (event) => broadcast(event), signal, stateForZip(zip), detailFirst);
          if (shouldStop) { broadcast({ type: 'log', message: 'Stopped by user' }); break; }

          const saved = leads.length > 0 ? insertLeads(leads) : 0;

          if (detailFirst && detailsMap.size > 0) {
            for (const lead of leads) {
              const d = detailsMap.get(lead.maps_url);
              if (!d) continue;
              const dbLead = getLeadByMapsUrl(lead.maps_url);
              if (dbLead) saveDetails(dbLead.id, d);
            }
            broadcast({ type: 'log', message: `${zip} / ${category}: full details saved for ${detailsMap.size} business(es)` });
          }
          const duplicates = leads.length - saved;
          broadcast({
            type: 'job-done',
            message: leads.length > 0
              ? `${zip} / ${category}: ${saved} saved, ${duplicates} duplicate(s)`
              : `${zip} / ${category}: no results`,
            found: leads.length,
            saved,
            duplicates,
          });

          // Pause between jobs so Google doesn't rate-limit and strip website chips
          if (!shouldStop && jobs[nextJob]) {
            const pause = 8000 + Math.floor(Math.random() * 7000); // 8–15s
            broadcast({ type: 'log', message: `Worker ${workerId}: waiting ${Math.round(pause/1000)}s before next job...` });
            await new Promise((r) => setTimeout(r, pause));
          }
        } catch (err) {
          if (shouldStop) { broadcast({ type: 'log', message: 'Stopped by user' }); break; }
          broadcast({ type: 'error', message: `Worker ${workerId} error on ${zip} / ${category}: ${String(err)} — continuing...` });
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(cappedWorkers, jobs.length) }, (_, i) => runWorker(i + 1)));
    } finally {
      scraping = false;
      stopping = false;
      activeScrapeController = null;
      broadcast({ type: 'done', message: '✅ All jobs complete.' });
    }
  })();
});

app.post('/api/scrape/stop', (_req, res) => {
  shouldStop = true;
  stopping = true;
  activeScrapeController?.abort();
  broadcast({ type: 'stopping', message: 'Stopping current scrape...' });
  res.json({ stopping: true });
});

// ── Leads ────────────────────────────────────────────────────────────────────
app.get('/api/leads', (_req, res) => {
  res.json(getAllLeads());
});

app.delete('/api/leads/:id', (req, res) => {
  const id = Number(req.params['id']);
  getDb().prepare('DELETE FROM leads WHERE id = ?').run(id);
  res.json({ deleted: id });
});

app.post('/api/leads/delete-all', (_req, res) => {
  getDb().exec('DELETE FROM leads');
  res.json({ deleted: true });
});

app.post('/api/leads/delete-bulk', (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  deleteLeads(ids.map(Number));
  res.json({ deleted: ids.length });
});

// ── SMS ──────────────────────────────────────────────────────────────────────
function isBusinessHours(): boolean {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 20; // Mon–Fri, 8am–8pm
}

app.get('/api/sms/check', async (_req, res) => {
  // Warn if scraper is running — it eats CPU and can cause ADB timeouts
  if (scraping) {
    res.json({ ok: false, reason: 'scraping', message: 'Scraper is running — it uses heavy CPU which can cause SMS to fail. Stop the scraper first, then send.' });
    return;
  }
  if (!isBusinessHours()) {
    const now = new Date();
    res.json({
      ok: false,
      reason: 'outside_hours',
      message: `It's ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — SMS sending is allowed Mon–Fri 8am–8pm only.`,
    });
    return;
  }
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    const ADB = process.platform === 'win32'
      ? `${process.env['LOCALAPPDATA']}\\Android\\Sdk\\platform-tools\\adb.exe`
      : 'adb';
    const { stdout } = await exec(ADB, ['devices']);
    const connected = stdout.trim().split('\n').slice(1).filter((l) => l.includes('\tdevice'));
    if (connected.length === 0) {
      res.json({ ok: false, reason: 'no_device', message: 'Pixel not connected — plug in via USB and unlock the phone.' });
      return;
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: false, reason: 'adb_missing', message: 'ADB not found. Make sure Android SDK platform-tools are installed.' });
  }
});

// Add to queue — resolve {name} and {location} immediately so queue shows real message
app.post('/api/sms/send', (req, res) => {
  const { leadIds, template = 'standard', templates } = req.body as {
    leadIds: number[];
    template: string;
    templates?: Record<string, { name: string; body: string }>;
  };

  const rawBody = templates?.[template]?.body ?? '';

  const items = leadIds.map((leadId) => {
    const lead = getLeadById(leadId);
    if (!lead) return null;
    const parts = (lead.address ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const location = parts.length >= 3 ? (parts[parts.length - 2] ?? lead.zip) :
                     parts.length === 2 ? (parts[0] ?? lead.zip) : lead.zip;
    const message = rawBody
      .replace(/\{name\}/g, lead.name)
      .replace(/\{location\}/g, location);
    return { leadId, template, message };
  }).filter((x): x is { leadId: number; template: string; message: string } => x !== null);

  const count = enqueueSmsBatch(items);
  res.json({ queued: count });
});

// Get queue
app.get('/api/sms/queue', (_req, res) => {
  res.json(getSmsQueue());
});

// Drain queue — user triggers this when ready
app.post('/api/sms/queue/send', async (req, res) => {
  const { force = false } = req.body as { force?: boolean };

  if (!force && !isBusinessHours()) {
    const now = new Date();
    res.status(400).json({
      error: 'outside_hours',
      message: `It's ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — SMS sending allowed Mon–Fri 8am–8pm only.`,
    });
    return;
  }

  const check = await (async () => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const exec = promisify(execFile);
      const ADB = process.platform === 'win32'
        ? `${process.env['LOCALAPPDATA']}\\Android\\Sdk\\platform-tools\\adb.exe`
        : 'adb';
      const { stdout } = await exec(ADB, ['devices']);
      return stdout.trim().split('\n').slice(1).some((l) => l.includes('\tdevice'));
    } catch { return false; }
  })();

  if (!check) {
    res.status(400).json({ error: 'no_device', message: 'Pixel not connected — plug in via USB and unlock the phone.' });
    return;
  }

  const pending = getSmsQueue('pending');
  const results: { id: number; leadId: number; success: boolean; error?: string }[] = [];

  for (const item of pending) {
    try {
      await sendSms(item.lead_id, item.template, item.message || undefined);
      markSmsQueueItem(item.id, 'sent');
      results.push({ id: item.id, leadId: item.lead_id, success: true });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const msg = String(err);
      markSmsQueueItem(item.id, 'failed', msg);
      results.push({ id: item.id, leadId: item.lead_id, success: false, error: msg });
      if (msg.includes('not connected') || msg.includes('no devices')) break;
    }
  }

  res.json({ results, sent: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length });
});

// Clear queue
app.post('/api/sms/queue/clear', (req, res) => {
  const { status } = req.body as { status?: 'sent' | 'failed' };
  clearSmsQueue(status);
  res.json({ ok: true });
});

// Test SMS — sends to your own number with sample data so you verify template looks right
app.post('/api/sms/test', async (req, res) => {
  const { to, body } = req.body as { to: string; body: string };
  if (!to || !body) { res.status(400).json({ error: 'to and body required' }); return; }

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    const ADB = process.platform === 'win32'
      ? `${process.env['LOCALAPPDATA']}\\Android\\Sdk\\platform-tools\\adb.exe`
      : 'adb';

    const { stdout } = await exec(ADB, ['devices']);
    const connected = stdout.trim().split('\n').slice(1).filter((l) => l.includes('\tdevice'));
    if (connected.length === 0) {
      res.status(400).json({ error: 'Pixel not connected — plug in via USB' });
      return;
    }

    const digits = to.replace(/\D/g, '');
    const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;

    const shellBody = body.replace(/'/g, `'\\''`);
    await exec(ADB, ['shell',
      `am start -a android.intent.action.SENDTO -d 'smsto:${e164}' --es sms_body '${shellBody}' --ez exit_on_sent true`,
    ]);
    await new Promise((r) => setTimeout(r, 3000));

    const { stdout: xml } = await (async () => {
      await exec(ADB, ['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
      return exec(ADB, ['shell', 'cat', '/sdcard/ui.xml']);
    })();

    const match = xml.match(/Compose:Draft:Send[^>]*bounds="?\[(\d+),(\d+)\]\[(\d+),(\d+)\]"?/);
    if (!match) { res.status(500).json({ error: 'Send button not found — is Google Messages open?' }); return; }

    const cx = Math.round((parseInt(match[1]!) + parseInt(match[3]!)) / 2);
    const cy = Math.round((parseInt(match[2]!) + parseInt(match[4]!)) / 2);
    await exec(ADB, ['shell', 'input', 'tap', String(cx), String(cy)]);

    res.json({ ok: true, to: e164, preview: body });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Full details ─────────────────────────────────────────────────────────────
app.post('/api/leads/:id/scrape-details', async (req, res) => {
  const id = Number(req.params['id']);
  const lead = getLeadById(id);
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!lead.maps_url) { res.status(400).json({ error: 'No Maps URL' }); return; }
  const details = await scrapeDetails(lead.maps_url);
  saveDetails(id, details);
  res.json(details);
});

// ── Bulk scrape details ───────────────────────────────────────────────────────
app.post('/api/leads/scrape-details-bulk', async (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  broadcast({ type: 'start', message: `📋 Detail scrape starting — ${ids.length} lead(s)` }, 'detail');
  const results: { id: number; name?: string; success: boolean; error?: string }[] = [];
  let done = 0;
  for (const rawId of ids) {
    const id = Number(rawId);
    const lead = getLeadById(id);
    if (!lead?.maps_url) {
      broadcast({ type: 'log', message: `⏭ #${id} — no Maps URL, skipping` }, 'detail');
      results.push({ id, success: false, error: 'No Maps URL' });
      continue;
    }
    broadcast({ type: 'log', message: `🔍 [${++done}/${ids.length}] ${lead.name}` }, 'detail');
    try {
      const details = await scrapeDetails(lead.maps_url);
      saveDetails(id, details);
      const parts = [];
      if (details.phone)      parts.push(`☎ ${details.phone}`);
      if (details.address)    parts.push(`📍 ${details.address}`);
      if (details.websiteUrl) parts.push(`🌐 ${details.websiteUrl}`);
      if (Object.keys(details.hours).length) parts.push(`🕐 ${Object.keys(details.hours).length} days hours`);
      broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${parts.join(' | ') || 'scraped'}` }, 'detail');
      results.push({ id, name: lead.name, success: true });
    } catch (err) {
      broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'detail');
      results.push({ id, name: lead.name, success: false, error: String(err) });
    }
  }
  broadcast({ type: 'done', message: `📋 Detail scrape complete — ${results.filter(r => r.success).length}/${ids.length} done` }, 'detail');
  res.json({ results });
});

// ── Reviews ───────────────────────────────────────────────────────────────────
app.get('/api/leads/:id/reviews', (req, res) => {
  const id = Number(req.params['id']);
  res.json(getReviews(id));
});

app.post('/api/leads/:id/scrape-reviews', async (req, res) => {
  const id = Number(req.params['id']);
  const lead = getLeadById(id);
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!lead.maps_url) { res.status(400).json({ error: 'No Maps URL for this lead' }); return; }

  const maxReviews = Number((req.body as { max?: number }).max ?? 50);
  const reviews = await scrapeReviews(lead.maps_url, maxReviews);
  saveReviews(id, reviews);
  markReviewScrape(id, 'done');
  const savedReviews = getReviews(id);
  res.json({ count: savedReviews.length, reviews: savedReviews });
});

app.post('/api/leads/scrape-reviews-bulk', async (req, res) => {
  const { ids, max = 50, force = false, reviewWorkers = 1 } = req.body as { ids?: number[]; max?: number; force?: boolean; reviewWorkers?: number };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  const cappedReviewWorkers = Math.min(Math.max(Number(reviewWorkers) || 1, 1), 1);
  void cappedReviewWorkers;

  broadcast({ type: 'start', message: `⭐ Review scrape starting — ${ids.length} lead(s)` }, 'reviews');
  const results: { id: number; name?: string; count: number; error?: string }[] = [];
  let rdone = 0;
  for (const rawId of ids) {
    const id = Number(rawId);
    const lead = getLeadById(id);
    if (!lead?.maps_url) {
      results.push({ id, count: 0, error: 'Lead not found or missing Maps URL' });
      continue;
    }
    if (!force && lead.review_scrape_status === 'done') {
      broadcast({ type: 'log', message: `⏭ ${lead.name} — already scraped, skipping` }, 'reviews');
      results.push({ id, name: lead.name, count: getReviews(id).length });
      continue;
    }
    broadcast({ type: 'log', message: `⭐ [${++rdone}/${ids.length}] ${lead.name}` }, 'reviews');
    try {
      const reviews = await scrapeReviews(lead.maps_url, Number(max) || 50);
      saveReviews(id, reviews);
      markReviewScrape(id, 'done');
      broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${reviews.length} review(s)` }, 'reviews');
      results.push({ id, name: lead.name, count: reviews.length });
    } catch (err) {
      markReviewScrape(id, 'error');
      broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'reviews');
      results.push({ id, name: lead.name, count: 0, error: String(err) });
    }
  }
  broadcast({ type: 'done', message: `⭐ Review scrape complete — ${results.filter(r => !r.error).length}/${ids.length} done` }, 'reviews');
  res.json({ results });
});

// ── Outreach log ─────────────────────────────────────────────────────────────
app.get('/api/outreach', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT o.*, l.name FROM outreach_log o
       JOIN leads l ON l.id = o.lead_id
       ORDER BY o.created_at DESC`,
    )
    .all();
  res.json(rows);
});

// ── Export vCard ─────────────────────────────────────────────────────────────
app.get('/api/leads/export.vcf', (_req, res) => {
  const all = getAllLeads();
  const leads = all.filter((l) => l.phone);
  const vcf = leads.map((l) => {
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${l.name}`,
      `TEL;TYPE=CELL:${l.phone}`,
    ];
    if (l.address) lines.push(`ADR;TYPE=WORK:;;${l.address};;;;`);
    if (l.website_url) lines.push(`URL:${l.website_url}`);
    if (l.category) lines.push(`ORG:${l.category}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  }).join('\r\n');
  res.setHeader('Content-Type', 'text/vcard');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.vcf"');
  res.send(vcf);
});

// ── Export CSV ───────────────────────────────────────────────────────────────
app.get('/api/leads/export.csv', (_req, res) => {
  const leads = getAllLeads();
  const headers = ['id', 'name', 'address', 'phone', 'category', 'rating', 'review_count', 'price_level', 'open_now', 'zip', 'has_website', 'website_url', 'maps_url', 'created_at'];
  const rows = leads.map((l) =>
    [l.id, l.name, l.address, l.phone, l.category, l.rating ?? '', l.review_count ?? '', l.price_level, l.open_now, l.zip, l.has_website, l.website_url, l.maps_url, l.created_at]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  );
  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(csv);
});

// ── Website scraper ───────────────────────────────────────────────────────────
app.post('/api/leads/scrape-websites-bulk', async (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
  res.json({ started: true, count: ids.length });

  broadcast({ type: 'start', message: `🌐 Website scrape starting — ${ids.length} lead(s)` }, 'website');

  let done = 0;
  for (const id of ids) {
    const lead = getLeadById(id);
    if (!lead) continue;

    if (!lead.website_url) {
      broadcast({ type: 'log', message: `⏭ #${id} ${lead.name} — no website URL, skipping` }, 'website');
      saveWebsiteData(id, { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, status: 'no_website' });
      continue;
    }

    broadcast({ type: 'log', message: `🔍 [${++done}/${ids.length}] Crawling ${lead.website_url} (${lead.name})...` }, 'website');

    try {
      const data = await scrapeWebsite(lead.website_url);
      saveWebsiteData(id, { ...data, status: 'done' });

      const parts: string[] = [];
      if (data.emails.length)      parts.push(`📧 ${data.emails.length} email(s): ${data.emails.slice(0, 3).join(', ')}`);
      if (data.phones.length)      parts.push(`📞 ${data.phones.length} phone(s): ${data.phones.slice(0, 2).join(', ')}`);
      if (data.socialLinks.length) parts.push(`🔗 ${data.socialLinks.map(s => s.platform).join(', ')}`);
      if (data.hasContactForm)     parts.push(`📋 contact form found`);

      broadcast({ type: 'log', message: parts.length
        ? `  ✅ ${lead.name}: ${parts.join(' | ')}`
        : `  ⚠ ${lead.name}: nothing found on site` }, 'website');
    } catch (err) {
      saveWebsiteData(id, { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, status: 'error' });
      broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'website');
    }
  }

  broadcast({ type: 'done', message: `🌐 Website scrape complete — ${ids.length} lead(s) processed` }, 'website');
});

// ── Contact form submitter ────────────────────────────────────────────────────
app.post('/api/leads/submit-forms-bulk', async (req, res) => {
  const { ids, sender } = req.body as {
    ids: number[];
    sender: { name: string; email: string; phone: string; message: string };
  };
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
  if (!sender?.name || !sender?.email || !sender?.message) { res.status(400).json({ error: 'sender name, email and message required' }); return; }

  const results: { id: number; name: string; success: boolean; error?: string }[] = [];
  for (const id of ids) {
    const lead = getLeadById(id);
    if (!lead?.website_contact_url) {
      results.push({ id, name: lead?.name ?? '', success: false, error: 'no contact form URL — run Scrape Websites first' });
      continue;
    }
    const result = await submitContactForm(lead.website_contact_url, { ...sender, message: sender.message.replace('{name}', lead.name) });
    if (result.success) {
      logOutreach({ leadId: id, zip: lead.zip, phone: lead.phone, channel: 'email', message: sender.message });
    }
    results.push({
      id,
      name: lead.name,
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
    });
    await new Promise((r) => setTimeout(r, 2000));
  }
  res.json({ results });
});

// ── Geo zip picker ────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'fs';

interface GeoData {
  states: { abbr: string; name: string }[];
  byState: Record<string, Record<string, { city: string; zip: string }[]>>;
}

const GEO_PATH = path.resolve(__dirname, '../../data/geo.json');
let geoData: GeoData | null = null;

function loadGeo(): GeoData | null {
  if (geoData) return geoData;
  if (!existsSync(GEO_PATH)) return null;
  geoData = JSON.parse(readFileSync(GEO_PATH, 'utf-8')) as GeoData;
  return geoData;
}

function stateForZip(zip: string): string | undefined {
  const data = loadGeo();
  if (!data) return undefined;
  for (const [abbr, counties] of Object.entries(data.byState)) {
    for (const zips of Object.values(counties)) {
      if (zips.some((z) => z.zip === zip)) return abbr;
    }
  }
  return undefined;
}

app.get('/api/geo/states', (_req, res) => {
  const data = loadGeo();
  if (!data) { res.status(503).json({ error: 'Run: node scripts/setup-geo.mjs' }); return; }
  res.json(data.states);
});

app.get('/api/geo/state/:abbr', (req, res) => {
  const data = loadGeo();
  if (!data) { res.status(503).json({ error: 'Run: node scripts/setup-geo.mjs' }); return; }
  res.json(data.byState[req.params['abbr'] ?? ''] ?? {});
});

// ── SMS Scheduler ─────────────────────────────────────────────────────────────
let scheduleTime: string | null = null; // "HH:MM" 24h format
let scheduleDays: number[] = [1, 2, 3, 4, 5]; // Mon–Fri by default

app.get('/api/sms/schedule', (_req, res) => {
  res.json({ time: scheduleTime, days: scheduleDays });
});

app.post('/api/sms/schedule', (req, res) => {
  const { time, days } = req.body as { time: string | null; days?: number[] };
  scheduleTime = time;
  if (days) scheduleDays = days;
  res.json({ time: scheduleTime, days: scheduleDays });
});

// Check every minute — drain queue automatically at scheduled time
setInterval(async () => {
  if (!scheduleTime) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm !== scheduleTime) return;
  if (!scheduleDays.includes(now.getDay())) return;

  const pending = getSmsQueue('pending');
  if (!pending.length) return;
  if (scraping) { broadcast({ type: 'log', message: '⏰ Scheduled SMS skipped — scraper is running' }); return; }

  broadcast({ type: 'log', message: `⏰ Scheduled SMS send starting — ${pending.length} messages in queue` });

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    const ADB = process.platform === 'win32'
      ? `${process.env['LOCALAPPDATA']}\\Android\\Sdk\\platform-tools\\adb.exe`
      : 'adb';
    const { stdout } = await exec(ADB, ['devices']);
    const connected = stdout.trim().split('\n').slice(1).filter((l) => l.includes('\tdevice'));
    if (!connected.length) {
      broadcast({ type: 'log', message: '⏰ Scheduled SMS skipped — Pixel not connected' });
      return;
    }
  } catch {
    broadcast({ type: 'log', message: '⏰ Scheduled SMS skipped — ADB error' });
    return;
  }

  let sent = 0; let failed = 0;
  for (const item of pending) {
    try {
      await sendSms(item.lead_id, item.template, item.message || undefined);
      markSmsQueueItem(item.id, 'sent');
      sent++;
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const msg = String(err);
      markSmsQueueItem(item.id, 'failed', msg);
      failed++;
      if (msg.includes('not connected') || msg.includes('no devices')) break;
    }
  }
  broadcast({ type: 'log', message: `⏰ Scheduled SMS done — ✅ ${sent} sent · ❌ ${failed} failed` });
}, 60_000);

// Prevent Playwright CDP / browser crash from killing the server
process.on('unhandledRejection', (reason) => {
  const msg = String(reason);
  if (msg.includes('Target page') || msg.includes('browser has been closed') || msg.includes('cdpSession') || msg.includes('Target closed')) {
    console.warn('[scraper] browser closed unexpectedly — caught and ignored:', msg.slice(0, 120));
    return;
  }
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  const msg = err.message ?? '';
  if (msg.includes('Target page') || msg.includes('browser has been closed') || msg.includes('cdpSession') || msg.includes('Target closed')) {
    console.warn('[scraper] browser crash caught — server stays up:', msg.slice(0, 120));
    return;
  }
  console.error('[uncaughtException]', err);
});

app.listen(PORT, () => {
  console.log(`\n  MapLeadHunter UI → http://localhost:${PORT}\n`);
});
