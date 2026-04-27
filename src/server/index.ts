import 'dotenv/config';
import os from 'os';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllLeads, insertLeads, deleteLeads, deleteAllLeads, getLeadById, getLeadByMapsUrl, saveReviews, getReviews, saveDetails, markReviewScrape, enqueueSmsBatch, getSmsQueue, markSmsQueueItem, clearSmsQueue, saveWebsiteData, logOutreach, markZipScraped, getScrapedZipSet, savePhotos, getOutreachLog, claimZip, releaseZip, releaseStaleZipClaims, logActivity, getRecentActivity } from '../leads/repository.js';
import { scrapeMapPhotos } from '../scraper/photo-scraper.js';
import { scrapeWebsite } from '../scraper/website-scraper.js';
import { submitContactForm } from '../scraper/form-submitter.js';
import { initDb, wipeAllData } from '../leads/db.js';
import { backupToSheets } from '../backup/sheets.js';
import { scrapeZip } from '../scraper/map-scraper.js';
import { sendSms } from '../outreach/sms.js';
import { scrapeReviews } from '../scraper/review-scraper.js';
import { scrapeDetails } from '../scraper/detail-scraper.js';
import { closeAllBrowsers } from '../utils/stealth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env['PORT'] ?? 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE broadcast ────────────────────────────────────────────────────────────
const sseClients = new Set<express.Response>();

type LogSource = 'main' | 'detail' | 'website' | 'reviews';

const HOST = os.hostname();

function broadcast(data: object, source: LogSource = 'main'): void {
  const msg = `data: ${JSON.stringify({ ...data, source })}\n\n`;
  sseClients.forEach((res) => res.write(msg));
  // Persist to Turso so other computers can see this activity
  const d = data as Record<string, unknown>;
  if (d['type'] && d['message']) {
    void logActivity(HOST, String(d['type']), String(d['message']), source).catch(() => null);
  }
}

app.get('/api/scrape/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
});

// ── Scrape control ───────────────────────────────────────────────────────────
let scraping = false;
let shouldStop = false;
let stopping = false;
let activeScrapeController: AbortController | null = null;
let sessionStats = { jobs: 0, found: 0, saved: 0, duplicates: 0 };

app.get('/api/scrape/status', (_req, res) => {
  res.json({ scraping, stopping, session: sessionStats });
});

app.post('/api/scrape/start', async (req, res) => {
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
    const done = await getScrapedZipSet();
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
    sessionStats = { jobs: 0, found: 0, saved: 0, duplicates: 0 };
    activeScrapeController = new AbortController();
    broadcast({ type: 'start', message: `Starting ${jobs.length} job(s) with ${cappedWorkers} worker(s)` });

    // Release stale claims from crashed sessions
    await releaseStaleZipClaims();
    const workerId = `${os.hostname()}-${process.pid}`;

    let nextJob = 0;
    const runWorker = async (workerNum: number) => {
      while (!shouldStop) {
        const job = jobs[nextJob++];
        if (!job) break;
        const { zip, category } = job;

        // Atomically claim this zip — if another computer already claimed it, skip
        const claimed = await claimZip(zip, category, workerId);
        if (!claimed) {
          broadcast({ type: 'log', message: `Worker ${workerNum}: ⏭ ${zip}/${category} already claimed by another computer — skipping` });
          continue;
        }

        broadcast({ type: 'log', message: `Worker ${workerNum}: scraping "${category}" near ${zip}...` });

        const signal = activeScrapeController?.signal;
        if (!signal || signal.aborted) { await releaseZip(zip, category); break; }

        try {
          const { leads, detailsMap } = await scrapeZip(zip, category, cappedMaxPerZip, (event) => broadcast(event), signal, stateForZip(zip), detailFirst);
          if (shouldStop) { broadcast({ type: 'log', message: 'Stopped by user' }); break; }

          const saved = leads.length > 0 ? await insertLeads(leads) : 0;
          const duplicates = leads.length - saved;
          await markZipScraped(zip, category, leads.length);
          sessionStats.jobs++;
          sessionStats.found += leads.length;
          sessionStats.saved += saved;
          sessionStats.duplicates += duplicates;

          if (detailFirst && detailsMap.size > 0) {
            for (const lead of leads) {
              const d = detailsMap.get(lead.maps_url);
              if (!d) continue;
              const dbLead = await getLeadByMapsUrl(lead.maps_url);
              if (dbLead) await saveDetails(dbLead.id, d);
            }
            broadcast({ type: 'log', message: `${zip} / ${category}: full details saved for ${detailsMap.size} business(es)` });
          }
          broadcast({
            type: 'job-done',
            message: leads.length > 0
              ? `${zip} / ${category}: ${saved} saved, ${duplicates} duplicate(s)`
              : `${zip} / ${category}: no results`,
            found: leads.length,
            saved,
            duplicates,
          });

          await releaseZip(zip, category);

          // Pause between jobs so Google doesn't rate-limit and strip website chips
          if (!shouldStop && jobs[nextJob]) {
            const pause = 8000 + Math.floor(Math.random() * 7000); // 8–15s
            broadcast({ type: 'log', message: `Worker ${workerNum}: waiting ${Math.round(pause/1000)}s before next job...` });
            await new Promise((r) => setTimeout(r, pause));
          }
        } catch (err) {
          await releaseZip(zip, category).catch(() => null);
          if (shouldStop) { broadcast({ type: 'log', message: 'Stopped by user' }); break; }
          broadcast({ type: 'error', message: `Worker ${workerNum} error on ${zip} / ${category}: ${String(err)} — continuing...` });
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
  closeAllBrowsers(); // kill active Playwright browsers immediately
  if (!scraping) {
    // Nothing running — reset any stale state and tell the client immediately
    scraping = false;
    stopping = false;
    broadcast({ type: 'done', message: '✅ Stopped.' });
    res.json({ stopping: false, scraping: false });
    return;
  }
  shouldStop = true;
  stopping = true;
  activeScrapeController?.abort();
  broadcast({ type: 'stopping', message: 'Stopping current scrape...' });
  res.json({ stopping: true });
});

// ── Leads ────────────────────────────────────────────────────────────────────
app.get('/api/leads', async (_req, res) => {
  res.json(await getAllLeads());
});

app.delete('/api/leads/:id', async (req, res) => {
  const id = Number(req.params['id']);
  await deleteLeads([id]);
  res.json({ deleted: id });
});

app.post('/api/leads/delete-all', async (_req, res) => {
  await deleteAllLeads();
  res.json({ deleted: true });
});

app.post('/api/db/wipe', async (_req, res) => {
  await wipeAllData();
  res.json({ ok: true });
});

app.post('/api/leads/delete-bulk', async (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  await deleteLeads(ids.map(Number));
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
app.post('/api/sms/send', async (req, res) => {
  const { leadIds, template = 'standard', templates } = req.body as {
    leadIds: number[];
    template: string;
    templates?: Record<string, { name: string; body: string }>;
  };

  const rawBody = templates?.[template]?.body ?? '';
  const items: { leadId: number; template: string; message: string }[] = [];

  for (const leadId of leadIds) {
    const lead = await getLeadById(leadId);
    if (!lead) continue;
    const parts = (lead.address ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const location = parts.length >= 3 ? (parts[parts.length - 2] ?? lead.zip) :
                     parts.length === 2 ? (parts[0] ?? lead.zip) : lead.zip;
    const message = rawBody.replace(/\{name\}/g, lead.name).replace(/\{location\}/g, location);
    items.push({ leadId, template, message });
  }

  const count = await enqueueSmsBatch(items);
  res.json({ queued: count });
});

// Get queue
app.get('/api/sms/queue', async (_req, res) => {
  res.json(await getSmsQueue());
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

  const pending = await getSmsQueue('pending');
  const results: { id: number; leadId: number; success: boolean; error?: string }[] = [];

  for (const item of pending) {
    try {
      await sendSms(item.lead_id, item.template, item.message || undefined);
      await markSmsQueueItem(item.id, 'sent');
      results.push({ id: item.id, leadId: item.lead_id, success: true });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const msg = String(err);
      await markSmsQueueItem(item.id, 'failed', msg);
      results.push({ id: item.id, leadId: item.lead_id, success: false, error: msg });
      if (msg.includes('not connected') || msg.includes('no devices')) break;
    }
  }

  res.json({ results, sent: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length });
});

// Clear queue
app.post('/api/sms/queue/clear', async (req, res) => {
  const { status } = req.body as { status?: 'sent' | 'failed' };
  await clearSmsQueue(status);
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
  const lead = await getLeadById(id);
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!lead.maps_url) { res.status(400).json({ error: 'No Maps URL' }); return; }
  const details = await scrapeDetails(lead.maps_url);
  await saveDetails(id, details);
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
    const lead = await getLeadById(id);
    if (!lead?.maps_url) {
      broadcast({ type: 'log', message: `⏭ #${id} — no Maps URL, skipping` }, 'detail');
      results.push({ id, success: false, error: 'No Maps URL' });
      continue;
    }
    broadcast({ type: 'log', message: `🔍 [${++done}/${ids.length}] ${lead.name}` }, 'detail');
    try {
      const details = await scrapeDetails(lead.maps_url);
      await saveDetails(id, details);
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
app.get('/api/leads/:id/reviews', async (req, res) => {
  const id = Number(req.params['id']);
  res.json(await getReviews(id));
});

app.post('/api/leads/:id/scrape-reviews', async (req, res) => {
  const id = Number(req.params['id']);
  const lead = await getLeadById(id);
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (!lead.maps_url) { res.status(400).json({ error: 'No Maps URL for this lead' }); return; }

  const maxReviews = Number((req.body as { max?: number }).max ?? 50);
  const reviews = await scrapeReviews(lead.maps_url, maxReviews);
  await saveReviews(id, reviews);
  await markReviewScrape(id, 'done');
  const savedReviews = await getReviews(id);
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
    const lead = await getLeadById(id);
    if (!lead?.maps_url) {
      results.push({ id, count: 0, error: 'Lead not found or missing Maps URL' });
      continue;
    }
    if (!force && lead.review_scrape_status === 'done') {
      broadcast({ type: 'log', message: `⏭ ${lead.name} — already scraped, skipping` }, 'reviews');
      results.push({ id, name: lead.name, count: (await getReviews(id)).length });
      continue;
    }
    broadcast({ type: 'log', message: `⭐ [${++rdone}/${ids.length}] ${lead.name}` }, 'reviews');
    try {
      const reviews = await scrapeReviews(lead.maps_url, Number(max) || 50);
      await saveReviews(id, reviews);
      await markReviewScrape(id, 'done');
      broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${reviews.length} review(s)` }, 'reviews');
      results.push({ id, name: lead.name, count: reviews.length });
    } catch (err) {
      await markReviewScrape(id, 'error');
      broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'reviews');
      results.push({ id, name: lead.name, count: 0, error: String(err) });
    }
  }
  broadcast({ type: 'done', message: `⭐ Review scrape complete — ${results.filter(r => !r.error).length}/${ids.length} done` }, 'reviews');
  res.json({ results });
});

// ── Outreach log ─────────────────────────────────────────────────────────────
app.get('/api/outreach', async (_req, res) => {
  res.json(await getOutreachLog());
});

// ── Export vCard ─────────────────────────────────────────────────────────────
app.get('/api/leads/export.vcf', async (_req, res) => {
  const all = await getAllLeads();
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
app.get('/api/leads/export.csv', async (_req, res) => {
  const leads = await getAllLeads();
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

  broadcast({ type: 'start', message: `🌐 Website scrape starting — ${ids.length} lead(s)` }, 'website');

  const results: { id: number; name?: string; success: boolean; error?: string }[] = [];
  let done = 0;
  for (const id of ids) {
    const lead = await getLeadById(id);
    if (!lead) continue;

    if (!lead.website_url) {
      broadcast({ type: 'log', message: `⏭ #${id} ${lead.name} — no website URL, skipping` }, 'website');
      await saveWebsiteData(id, { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, status: 'no_website' });
      results.push({ id, name: lead.name, success: true });
      continue;
    }

    broadcast({ type: 'log', message: `🔍 [${++done}/${ids.length}] Crawling ${lead.website_url} (${lead.name})...` }, 'website');

    try {
      const data = await scrapeWebsite(lead.website_url);
      await saveWebsiteData(id, { ...data, status: 'done' });

      const parts: string[] = [];
      if (data.emails.length)      parts.push(`📧 ${data.emails.length} email(s): ${data.emails.slice(0, 3).join(', ')}`);
      if (data.phones.length)      parts.push(`📞 ${data.phones.length} phone(s): ${data.phones.slice(0, 2).join(', ')}`);
      if (data.socialLinks.length) parts.push(`🔗 ${data.socialLinks.map(s => s.platform).join(', ')}`);
      if (data.hasContactForm)     parts.push(`📋 contact form found`);

      broadcast({ type: 'log', message: parts.length
        ? `  ✅ ${lead.name}: ${parts.join(' | ')}`
        : `  ⚠ ${lead.name}: nothing found on site` }, 'website');
      results.push({ id, name: lead.name, success: true });
    } catch (err) {
      await saveWebsiteData(id, { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, status: 'error' });
      broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'website');
      results.push({ id, name: lead.name, success: false, error: String(err) });
    }
  }

  broadcast({ type: 'done', message: `🌐 Website scrape complete — ${ids.length} lead(s) processed` }, 'website');
  res.json({ results });
});

// ── Photo scraper ─────────────────────────────────────────────────────────────
app.post('/api/leads/scrape-photos-bulk', async (req, res) => {
  const { ids, max = 20 } = req.body as { ids: number[]; max?: number };
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }

  broadcast({ type: 'start', message: `📷 Photo scrape starting — ${ids.length} lead(s)` }, 'detail');
  const results: { id: number; name?: string; count: number; error?: string }[] = [];
  let done = 0;

  for (const id of ids) {
    const lead = await getLeadById(id);
    if (!lead?.maps_url) { results.push({ id, count: 0, error: 'No Maps URL' }); continue; }
    broadcast({ type: 'log', message: `📷 [${++done}/${ids.length}] ${lead.name}` }, 'detail');
    try {
      const photos = await scrapeMapPhotos(lead.maps_url, Number(max) || 20);
      await savePhotos(id, photos);
      broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${photos.length} photo(s)` }, 'detail');
      results.push({ id, name: lead.name, count: photos.length });
    } catch (err) {
      broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'detail');
      results.push({ id, name: lead.name, count: 0, error: String(err) });
    }
  }

  broadcast({ type: 'done', message: `📷 Photo scrape complete — ${results.filter(r => !r.error).length}/${ids.length} done` }, 'detail');
  res.json({ results });
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
    const lead = await getLeadById(id);
    if (!lead?.website_contact_url) {
      results.push({ id, name: lead?.name ?? '', success: false, error: 'no contact form URL — run Scrape Websites first' });
      continue;
    }
    const result = await submitContactForm(lead.website_contact_url, { ...sender, message: sender.message.replace('{name}', lead.name) });
    if (result.success) {
      await logOutreach({ leadId: id, zip: lead.zip, phone: lead.phone, channel: 'email', message: sender.message });
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

  const pending = await getSmsQueue('pending');
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
      await markSmsQueueItem(item.id, 'sent');
      sent++;
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const msg = String(err);
      await markSmsQueueItem(item.id, 'failed', msg);
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

// Start server immediately, init DB in background so UI is available right away
app.listen(PORT, () => {
  console.log(`\n  MapLeadHunter UI → http://localhost:${PORT}\n`);
  initDb()
    .then(() => console.log('[db] migrations done'))
    .catch((err) => console.error('[db] init failed:', err));
});

// ── Cross-computer activity feed ─────────────────────────────────────────────
app.get('/api/activity', async (req, res) => {
  const since = Number((req.query as Record<string, string>)['since'] ?? 0);
  res.json(await getRecentActivity(since));
});

// ── Active scrape claims (what every computer is doing right now) ─────────────
app.get('/api/scrape/claims', async (_req, res) => {
  const r = await getDb().execute('SELECT zip, category, claimed_by, claimed_at FROM scrape_claims');
  res.json(r.rows.map(row => ({
    zip: String(row[0]),
    category: String(row[1]),
    claimed_by: String(row[2]),
    claimed_at: String(row[3]),
  })));
});

// ── Real-time log viewer ─────────────────────────────────────────────────────
import { createReadStream, watchFile, statSync, existsSync } from 'fs';
import os from 'os';

// Serve a self-contained log viewer page
app.get('/logs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>MapLeadHunter — Live Logs</title>
<style>
  body { margin:0; background:#0f172a; color:#e2e8f0; font-family:monospace; font-size:13px; }
  #bar { position:sticky; top:0; background:#1e293b; padding:8px 14px; display:flex; align-items:center; gap:12px; border-bottom:1px solid #334155; }
  #bar h1 { margin:0; font-size:15px; font-weight:700; color:#818cf8; }
  #bar span { font-size:11px; color:#64748b; }
  #wrap { padding:12px 14px; }
  .line { white-space:pre-wrap; word-break:break-all; line-height:1.55; padding:1px 0; }
  .err  { color:#f87171; }
  .warn { color:#fb923c; }
  .ok   { color:#4ade80; }
  .dim  { color:#64748b; }
  #end  { height:40px; }
</style></head><body>
<div id="bar"><h1>MapLeadHunter Live Logs</h1><span id="st">connecting…</span>
  <button onclick="paused=!paused;this.textContent=paused?'▶ Resume':'⏸ Pause'" style="margin-left:auto;background:#334155;border:none;color:#e2e8f0;padding:4px 10px;border-radius:4px;cursor:pointer">⏸ Pause</button>
  <button onclick="document.getElementById('wrap').innerHTML='';lines=0" style="background:#334155;border:none;color:#e2e8f0;padding:4px 10px;border-radius:4px;cursor:pointer">🗑 Clear</button>
</div>
<div id="wrap"></div><div id="end"></div>
<script>
var paused = false, lines = 0;
var wrap = document.getElementById('wrap');
var st   = document.getElementById('st');

function addLine(text) {
  if (paused) return;
  var d = document.createElement('div');
  d.className = 'line' + (text.includes(':err]') || text.includes('Error') || text.includes('error') ? ' err' : text.includes('warn') || text.includes('Warn') ? ' warn' : text.includes('✅') || text.includes('done') || text.includes('saved') ? ' ok' : text.startsWith('===') ? ' dim' : '');
  d.textContent = text;
  wrap.appendChild(d);
  if (++lines > 2000) { wrap.removeChild(wrap.firstChild); lines--; }
  document.getElementById('end').scrollIntoView({ behavior:'auto' });
}

var es = new EventSource('/logs/stream');
es.onopen = function() { st.textContent = '● live'; st.style.color='#4ade80'; };
es.onmessage = function(e) { addLine(e.data); };
es.onerror = function() { st.textContent = '○ reconnecting…'; st.style.color='#fb923c'; };
</script></body></html>`);
});

// SSE stream of log file lines (tail -f style)
app.get('/logs/stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const LOG_FILE = (() => {
    // Match where app-main.cjs writes: userData/logs/app.log
    // userData on Windows: %APPDATA%\MapLeadHunter
    const appData = process.env['APPDATA'] || os.homedir();
    return require('path').join(appData, 'MapLeadHunter', 'logs', 'app.log');
  })();

  const send = (line: string) => res.write(`data: ${line.replace(/\r?\n/g, ' ')}\n\n`);

  // Send last 200 lines immediately (tail)
  if (existsSync(LOG_FILE)) {
    try {
      const { readFileSync } = require('fs') as typeof import('fs');
      const content = readFileSync(LOG_FILE, 'utf-8');
      const tail = content.split('\n').filter(Boolean).slice(-200);
      tail.forEach(send);
    } catch { /* ignore */ }
  } else {
    send('(log file not found — logs will appear here once the app starts)');
  }

  // Watch for new content
  let lastSize = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
  let buf = '';

  const watcher = setInterval(() => {
    if (!existsSync(LOG_FILE)) return;
    const size = statSync(LOG_FILE).size;
    if (size <= lastSize) return;
    const chunk = Buffer.alloc(size - lastSize);
    const fd = require('fs').openSync(LOG_FILE, 'r');
    require('fs').readSync(fd, chunk, 0, chunk.length, lastSize);
    require('fs').closeSync(fd);
    lastSize = size;
    buf += chunk.toString('utf-8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    lines.filter(Boolean).forEach(send);
  }, 500);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => { clearInterval(watcher); clearInterval(heartbeat); });
});

// ── Google Sheets backup ──────────────────────────────────────────────────────
app.post('/api/backup/sheets', async (_req, res) => {
  try {
    const result = await backupToSheets();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

