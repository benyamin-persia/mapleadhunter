import 'dotenv/config';
import os from 'os';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { getAllLeads, getLeadList, getLeadCount, insertLeads, deleteLeads, deleteAllLeads, getLeadById, getLeadByMapsUrl, saveReviews, getReviews, saveDetails, markReviewScrape, enqueueSmsBatch, getSmsQueue, markSmsQueueItem, clearSmsQueue, saveWebsiteData, logOutreach, markZipScraped, getScrapedZipSet, getCategoryZipStatuses, savePhotos, getOutreachLog, claimZip, releaseZip, releaseStaleZipClaims, logActivity, getRecentActivity, getActivityHistory, createScrapeRun, updateScrapeRun, markScrapeRunItem, getLatestResumableScrapeRun, getScrapeRun, getPendingScrapeRunItems } from '../leads/repository.js';
import type { ScrapeRun } from '../leads/repository.js';
import { scrapeMapPhotos } from '../scraper/photo-scraper.js';
import { scrapeWebsite } from '../scraper/website-scraper.js';
import { submitContactForm } from '../scraper/form-submitter.js';
import { getDb, initDb, resetScrapeProcessData, wipeAllData } from '../leads/db.js';
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

type LogSource = 'main' | 'detail' | 'website' | 'reviews' | 'photos' | 'sms' | 'forms';
type MapScrapeJob = { zip: string; category: string };
type SessionStats = {
  runId: string;
  total: number;
  jobs: number;
  found: number;
  saved: number;
  duplicates: number;
  skipped: number;
  failed: number;
};

const HOST = os.hostname();

function broadcast(data: object, source: LogSource = 'main'): void {
  const msg = `data: ${JSON.stringify({ ...data, source, host: HOST })}\n\n`;
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
let pauseRequested = false;
let stopping = false;
let activeScrapeController: AbortController | null = null;
let secondaryShouldStop = false;

function emptySessionStats(): SessionStats {
  return { runId: '', total: 0, jobs: 0, found: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 };
}

let sessionStats: SessionStats = emptySessionStats();

function resetScrapeState(): void {
  shouldStop = false;
  pauseRequested = false;
  stopping = false;
  activeScrapeController = null;
  sessionStats = emptySessionStats();
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionFromRun(run: ScrapeRun): SessionStats {
  return {
    runId: run.id,
    total: n(run.total_items),
    jobs: n(run.completed_items),
    found: n(run.found),
    saved: n(run.saved),
    duplicates: n(run.duplicates),
    skipped: n(run.skipped_items),
    failed: n(run.failed_items),
  };
}

app.get('/api/scrape/status', async (_req, res) => {
  if (!scraping && !sessionStats.runId) {
    const run = await getLatestResumableScrapeRun();
    if (run) {
      res.json({ scraping, stopping, session: sessionFromRun(run) });
      return;
    }
  }
  res.json({ scraping, stopping, session: sessionStats });
});

async function runMapScrapeSession(opts: {
  runId: string;
  jobs: MapScrapeJob[];
  maxPerZip: number;
  workers: number;
  detailFirst: boolean;
}): Promise<void> {
  const { runId, jobs, maxPerZip, workers, detailFirst } = opts;
  const scraperType = detailFirst ? 'maps_detail' : 'maps_fast';
  const savedRun = await getScrapeRun(runId);

  scraping = true;
  shouldStop = false;
  pauseRequested = false;
  stopping = false;
  sessionStats = savedRun
    ? sessionFromRun(savedRun)
    : { runId, total: jobs.length, jobs: 0, found: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 };
  activeScrapeController = new AbortController();
  await updateScrapeRun(runId, { status: 'running', message: `Starting ${jobs.length} remaining job(s)` });
  broadcast({
    type: 'start',
    ...sessionStats,
    message: `Starting ${jobs.length} remaining job(s) with ${workers} worker(s)`,
  });

  await releaseStaleZipClaims();
  const workerId = `${HOST}:${process.pid}`;

  let nextJob = 0;
  const runWorker = async (workerNum: number) => {
    while (!shouldStop) {
      const job = jobs[nextJob++];
      if (!job) break;
      const { zip, category } = job;

      const claimed = await claimZip(zip, category, workerId, scraperType);
      if (!claimed) {
        sessionStats.skipped++;
        await markScrapeRunItem(runId, zip, category, 'skipped', { reason: 'claimed' });
        await updateScrapeRun(runId, { skippedDelta: 1, message: `${zip}/${category} already claimed` });
        broadcast({ type: 'log', message: `Worker ${workerNum}: ${zip}/${category} already claimed by another computer - skipping` });
        broadcast({ type: 'job-skipped', runId, zip, category, message: `${zip} / ${category}: skipped because another computer claimed it` });
        continue;
      }

      await markScrapeRunItem(runId, zip, category, 'running');
      await updateScrapeRun(runId, { cursor: { zip, category, worker: workerNum }, message: `Scraping ${category} near ${zip}` });
      broadcast({ type: 'log', message: `Worker ${workerNum}: scraping "${category}" near ${zip}...` });

      const signal = activeScrapeController?.signal;
      if (!signal || signal.aborted) { await releaseZip(zip, category); break; }

      try {
        const { leads, detailsMap } = await scrapeZip(zip, category, maxPerZip, (event) => broadcast(event), signal, stateForZip(zip), detailFirst);
        if (shouldStop && !pauseRequested) {
          await markScrapeRunItem(runId, zip, category, 'pending', {}, 'Stopped by user');
          await releaseZip(zip, category);
          break;
        }

        const saved = leads.length > 0 ? await insertLeads(leads) : 0;
        const duplicates = leads.length - saved;
        await markZipScraped(zip, category, leads.length, scraperType);
        sessionStats.jobs++;
        sessionStats.found += leads.length;
        sessionStats.saved += saved;
        sessionStats.duplicates += duplicates;
        await updateScrapeRun(runId, {
          completedDelta: 1,
          foundDelta: leads.length,
          savedDelta: saved,
          duplicatesDelta: duplicates,
          cursor: { zip, category, worker: workerNum },
          message: `${zip}/${category}: ${saved} saved, ${duplicates} duplicate(s)`,
        });
        await markScrapeRunItem(runId, zip, category, 'done', { found: leads.length, saved, duplicates });

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

        if (!shouldStop && jobs[nextJob]) {
          const pause = 8000 + Math.floor(Math.random() * 7000);
          broadcast({ type: 'log', message: `Worker ${workerNum}: waiting ${Math.round(pause / 1000)}s before next job...` });
          await new Promise((r) => setTimeout(r, pause));
        }
      } catch (err) {
        const msg = String(err);
        await releaseZip(zip, category).catch(() => null);
        if (shouldStop) {
          await markScrapeRunItem(runId, zip, category, 'pending', {}, msg);
          broadcast({ type: 'log', message: pauseRequested ? 'Pausing after current work...' : 'Stopped by user. Current job remains pending for resume.' });
          break;
        }
        await markScrapeRunItem(runId, zip, category, 'failed', {}, msg);
        await updateScrapeRun(runId, { failedDelta: 1, message: `${zip}/${category} failed: ${msg}` });
        sessionStats.failed++;
        broadcast({ type: 'error', message: `Worker ${workerNum} error on ${zip} / ${category}: ${msg} - continuing...` });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, (_, i) => runWorker(i + 1)));
  } finally {
    const status = pauseRequested ? 'paused' : shouldStop ? 'stopped' : sessionStats.failed > 0 ? 'failed' : 'done';
    const message = status === 'paused' ? 'Paused. You can resume this run later.' :
                    status === 'stopped' ? 'Stopped. You can resume this run later.' :
                    status === 'failed' ? `Finished with ${sessionStats.failed} failed job(s). You can resume to retry them.` :
                    'All jobs complete.';
    await updateScrapeRun(runId, { status, message });
    scraping = false;
    stopping = false;
    activeScrapeController = null;
    broadcast({ type: status === 'paused' ? 'paused' : status === 'stopped' ? 'stopped' : 'done', ...sessionStats, message });
    pauseRequested = false;
  }
}

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

  let jobs: MapScrapeJob[] = [];
  for (const zip of zips) for (const category of categories) jobs.push({ zip, category });
  const scraperType = detailFirst ? 'maps_detail' : 'maps_fast';

  if (skipScraped) {
    const done = await getScrapedZipSet(); // no method filter — skip if scraped with ANY method
    const before = jobs.length;
    jobs = jobs.filter((j) => !done.has(`${j.zip}::${j.category.toLowerCase()}`));
    const skipped = before - jobs.length;
    if (skipped > 0 && jobs.length === 0) {
      broadcast({ type: 'log', message: `All selected zip/category jobs were already scraped` });
      res.json({ started: false, skipped, jobs: 0, message: 'All selected zips already scraped.' });
      return;
    }
  }

  const runId = await createScrapeRun({
    host: HOST,
    scraperType,
    request: { zips, categories, maxPerZip: cappedMaxPerZip, workers: cappedWorkers, skipScraped, detailFirst },
    items: jobs.map((job) => ({ ...job, scraperType })),
  });
  const session: SessionStats = { runId, total: jobs.length, jobs: 0, found: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 };

  res.json({ started: true, jobs: jobs.length, runId, session });
  void runMapScrapeSession({ runId, jobs, maxPerZip: cappedMaxPerZip, workers: cappedWorkers, detailFirst });
});

app.get('/api/scrape/resumable', async (_req, res) => {
  const run = await getLatestResumableScrapeRun();
  if (!run) { res.json({ run: null, pending: 0 }); return; }
  const pending = await getPendingScrapeRunItems(run.id);
  res.json({ run, pending: pending.length, session: sessionFromRun(run) });
});

app.post('/api/scrape/resume', async (_req, res) => {
  if (scraping) {
    res.status(409).json({ error: 'Scrape already running' });
    return;
  }
  const run = await getLatestResumableScrapeRun();
  if (!run) {
    broadcast({ type: 'log', message: 'Resume requested, but no paused or resumable scrape was found' });
    res.status(404).json({ error: 'No paused or resumable scrape found' });
    return;
  }
  const pending = await getPendingScrapeRunItems(run.id);
  const jobs = pending.map((item) => ({ zip: item.zip, category: item.category }));
  if (!jobs.length) {
    await updateScrapeRun(run.id, { status: 'done', message: 'No pending items left to resume' });
    broadcast({ type: 'log', runId: run.id, message: 'Resume requested, but no pending items were left' });
    res.json({ resumed: false, message: 'No pending items left to resume' });
    return;
  }
  const request = JSON.parse(run.request_json || '{}') as { maxPerZip?: number; workers?: number; detailFirst?: boolean };
  const maxPerZip = Math.min(Math.max(Number(request.maxPerZip) || 500, 1), 500);
  const workers = Math.min(Math.max(Number(request.workers) || 1, 1), 10);
  const detailFirst = run.scraper_type === 'maps_detail' || request.detailFirst === true;
  res.json({ resumed: true, runId: run.id, jobs: jobs.length, session: sessionFromRun(run) });
  void runMapScrapeSession({ runId: run.id, jobs, maxPerZip, workers, detailFirst });
});

app.post('/api/scrape/pause', (_req, res) => {
  if (!scraping) {
    res.json({ paused: false, scraping: false });
    return;
  }
  pauseRequested = true;
  shouldStop = true;
  stopping = true;
  broadcast({ type: 'pausing', message: 'Pausing after the current zip/category finishes...' });
  res.json({ paused: true });
});

app.post('/api/scrape/stop', (_req, res) => {
  closeAllBrowsers(); // kill active Playwright browsers immediately
  secondaryShouldStop = true; // also stop any running secondary scrapers
  if (!scraping) {
    // Nothing running — reset any stale state and tell the client immediately
    scraping = false;
    stopping = false;
    pauseRequested = false;
    broadcast({ type: 'done', message: 'Stopped.' });
    res.json({ stopping: false, scraping: false });
    return;
  }
  pauseRequested = false;
  shouldStop = true;
  stopping = true;
  activeScrapeController?.abort();
  broadcast({ type: 'stopping', message: 'Stopping current scrape...' });
  res.json({ stopping: true });
});

app.post('/api/scrape/stop-secondary', (_req, res) => {
  secondaryShouldStop = true;
  (['detail', 'website', 'reviews', 'photos'] as const).forEach(src =>
    broadcast({ type: 'log', message: '🛑 Stop requested — finishing current item then stopping...' }, src)
  );
  res.json({ stopping: true });
});

app.post('/api/scrape/reset', async (_req, res) => {
  if (scraping) {
    res.status(409).json({ error: 'Stop or pause the scraper before resetting progress' });
    return;
  }
  await resetScrapeProcessData();
  resetScrapeState();
  broadcast({ type: 'reset', ...sessionStats, message: 'Scrape process reset. Ready to start from first.' });
  res.json({ ok: true, session: sessionStats });
});

// ── Leads ────────────────────────────────────────────────────────────────────
app.get('/api/leads', async (_req, res) => {
  res.json(await getLeadList());
});

app.get('/api/leads/count', async (_req, res) => {
  res.json({ total: await getLeadCount() });
});

app.get('/api/leads/:id', async (req, res) => {
  const id = Number(req.params['id']);
  const lead = await getLeadById(id);
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  res.json(lead);
});

app.delete('/api/leads/:id', async (req, res) => {
  const id = Number(req.params['id']);
  await deleteLeads([id]);
  broadcast({ type: 'log', message: `Deleted lead #${id}` });
  res.json({ deleted: id });
});

app.post('/api/leads/delete-all', async (_req, res) => {
  await deleteAllLeads();
  broadcast({ type: 'log', message: 'Deleted all leads' });
  res.json({ deleted: true });
});

app.post('/api/db/wipe', async (_req, res) => {
  if (scraping) {
    res.status(409).json({ error: 'Stop or pause the scraper before wiping the database' });
    return;
  }
  await wipeAllData();
  resetScrapeState();
  broadcast({ type: 'log', message: 'Database wiped' });
  res.json({ ok: true });
});

app.post('/api/leads/delete-bulk', async (req, res) => {
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  await deleteLeads(ids.map(Number));
  broadcast({ type: 'log', message: `Deleted ${ids.length} lead(s)` });
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
  if (!rawBody.trim()) {
    res.status(400).json({ error: 'Selected SMS template is empty or missing' });
    return;
  }
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
  broadcast({ type: 'log', message: `Queued ${count} SMS message(s) using template "${template}"` }, 'sms');
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
  broadcast({ type: 'start', message: `SMS queue send starting - ${pending.length} pending message(s)` }, 'sms');

  for (const item of pending) {
    try {
      await sendSms(item.lead_id, item.template, item.message || undefined);
      await markSmsQueueItem(item.id, 'sent');
      broadcast({ type: 'log', message: `Sent SMS queue item #${item.id} to lead #${item.lead_id}` }, 'sms');
      results.push({ id: item.id, leadId: item.lead_id, success: true });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const msg = String(err);
      await markSmsQueueItem(item.id, 'failed', msg);
      broadcast({ type: 'error', message: `SMS queue item #${item.id} failed: ${msg}` }, 'sms');
      results.push({ id: item.id, leadId: item.lead_id, success: false, error: msg });
      if (msg.includes('not connected') || msg.includes('no devices')) break;
    }
  }

  broadcast({ type: 'done', message: `SMS queue done - ${results.filter((r) => r.success).length} sent, ${results.filter((r) => !r.success).length} failed` }, 'sms');
  res.json({ results, sent: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length });
});

// Clear queue
app.post('/api/sms/queue/clear', async (req, res) => {
  const { status } = req.body as { status?: 'sent' | 'failed' };
  await clearSmsQueue(status);
  broadcast({ type: 'log', message: status ? `Cleared ${status} SMS queue items` : 'Cleared SMS queue' }, 'sms');
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
    broadcast({ type: 'log', message: `Test SMS sent to ${e164}` }, 'sms');
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
  broadcast({ type: 'start', message: `Detail scrape starting for ${lead.name}` }, 'detail');
  try {
    const details = await scrapeDetails(lead.maps_url);
    await saveDetails(id, details);
    broadcast({ type: 'done', message: `Detail scrape done for ${lead.name}` }, 'detail');
    res.json(details);
  } catch (err) {
    broadcast({ type: 'error', message: `Detail scrape failed for ${lead.name}: ${String(err)}` }, 'detail');
    res.status(500).json({ error: String(err) });
  }
});

// ── Bulk scrape details ───────────────────────────────────────────────────────
app.post('/api/leads/scrape-details-bulk', async (req, res) => {
  const { ids, workers = 3, force = false } = req.body as { ids: number[]; workers?: number; force?: boolean };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  const concurrency = Math.min(Math.max(Number(workers) || 3, 1), 10);
  secondaryShouldStop = false;
  broadcast({ type: 'start', message: `📋 Detail scrape starting — ${ids.length} lead(s) · ${concurrency} workers${force ? ' · force' : ''}`, total: ids.length }, 'detail');
  const results: { id: number; name?: string; success: boolean; error?: string }[] = [];
  let done = 0;
  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (!secondaryShouldStop) {
      const rawId = queue.shift();
      if (rawId === undefined) break;
      const id = Number(rawId);
      const lead = await getLeadById(id);
      if (!lead?.maps_url) {
        broadcast({ type: 'log', message: `⏭ #${id} — no Maps URL, skipping` }, 'detail');
        results.push({ id, success: false, error: 'No Maps URL' });
        continue;
      }
      if (!force && lead.details_scraped) {
        broadcast({ type: 'log', message: `⏭ ${lead.name} — details already scraped, skipping` }, 'detail');
        results.push({ id, name: lead.name, success: true });
        continue;
      }
      broadcast({ type: 'log', message: `🔍 [${++done}/${ids.length}] ${lead.name}`, current: done, total: ids.length }, 'detail');
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
  }));
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
  broadcast({ type: 'start', message: `Review scrape starting for ${lead.name}` }, 'reviews');
  try {
    const reviews = await scrapeReviews(lead.maps_url, maxReviews);
    await saveReviews(id, reviews);
    await markReviewScrape(id, 'done');
    const savedReviews = await getReviews(id);
    broadcast({ type: 'done', message: `Review scrape done for ${lead.name}: ${savedReviews.length} review(s)` }, 'reviews');
    res.json({ count: savedReviews.length, reviews: savedReviews });
  } catch (err) {
    await markReviewScrape(id, 'error');
    broadcast({ type: 'error', message: `Review scrape failed for ${lead.name}: ${String(err)}` }, 'reviews');
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/leads/scrape-reviews-bulk', async (req, res) => {
  const { ids, max = 50, force = false, reviewWorkers = 3 } = req.body as { ids?: number[]; max?: number; force?: boolean; reviewWorkers?: number };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  const concurrency = Math.min(Math.max(Number(reviewWorkers) || 3, 1), 10);
  secondaryShouldStop = false;
  broadcast({ type: 'start', message: `⭐ Review scrape starting — ${ids.length} lead(s) · ${concurrency} workers`, total: ids.length }, 'reviews');
  const results: { id: number; name?: string; count: number; error?: string }[] = [];
  let rdone = 0;
  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (!secondaryShouldStop) {
      const rawId = queue.shift();
      if (rawId === undefined) break;
      const id = Number(rawId);
      const lead = await getLeadById(id);
      if (!lead?.maps_url) {
        broadcast({ type: 'log', message: `#${id} missing Maps URL - skipping` }, 'reviews');
        results.push({ id, count: 0, error: 'Lead not found or missing Maps URL' });
        continue;
      }
      if (!force && lead.review_scrape_status === 'done') {
        broadcast({ type: 'log', message: `⏭ ${lead.name} — already scraped, skipping` }, 'reviews');
        results.push({ id, name: lead.name, count: (await getReviews(id)).length });
        continue;
      }
      broadcast({ type: 'log', message: `⭐ [${++rdone}/${ids.length}] ${lead.name}`, current: rdone, total: ids.length }, 'reviews');
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
  }));
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
  broadcast({ type: 'log', message: `Exported ${leads.length} lead(s) to vCard` });
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
  broadcast({ type: 'log', message: `Exported ${leads.length} lead(s) to CSV` });
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
  const { ids, workers = 3, force = false } = req.body as { ids: number[]; workers?: number; force?: boolean };
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
  const concurrency = Math.min(Math.max(Number(workers) || 3, 1), 10);
  secondaryShouldStop = false;
  broadcast({ type: 'start', message: `🌐 Website scrape starting — ${ids.length} lead(s) · ${concurrency} workers${force ? ' · force' : ''}`, total: ids.length }, 'website');

  const results: { id: number; name?: string; success: boolean; error?: string }[] = [];
  let done = 0;
  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (!secondaryShouldStop) {
      const rawId = queue.shift();
      if (rawId === undefined) break;
      const id = Number(rawId);
      const lead = await getLeadById(id);
      if (!lead) continue;

      if (!lead.website_url) {
        broadcast({ type: 'log', message: `⏭ #${id} ${lead.name} — no website URL, skipping` }, 'website');
        await saveWebsiteData(id, { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, status: 'no_website' });
        results.push({ id, name: lead.name, success: true });
        continue;
      }
      if (!force && lead.website_scrape_status === 'done') {
        broadcast({ type: 'log', message: `⏭ ${lead.name} — website already crawled, skipping` }, 'website');
        results.push({ id, name: lead.name, success: true });
        continue;
      }

      broadcast({ type: 'log', message: `🔍 [${++done}/${ids.length}] Crawling ${lead.website_url} (${lead.name})...`, current: done, total: ids.length }, 'website');

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
  }));

  broadcast({ type: 'done', message: `🌐 Website scrape complete — ${ids.length} lead(s) processed` }, 'website');
  res.json({ results });
});

// ── Photo scraper ─────────────────────────────────────────────────────────────
app.post('/api/leads/scrape-photos-bulk', async (req, res) => {
  const { ids, max = 20, workers = 3, force = false } = req.body as { ids: number[]; max?: number; workers?: number; force?: boolean };
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
  const concurrency = Math.min(Math.max(Number(workers) || 3, 1), 10);
  secondaryShouldStop = false;
  broadcast({ type: 'start', message: `📷 Photo scrape starting — ${ids.length} lead(s) · ${concurrency} workers${force ? ' · force' : ''}`, total: ids.length }, 'photos');
  const results: { id: number; name?: string; count: number; error?: string }[] = [];
  let done = 0;
  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (!secondaryShouldStop) {
      const rawId = queue.shift();
      if (rawId === undefined) break;
      const id = Number(rawId);
      const lead = await getLeadById(id);
      if (!lead?.maps_url) {
        broadcast({ type: 'log', message: `#${id} missing Maps URL - skipping` }, 'photos');
        results.push({ id, count: 0, error: 'No Maps URL' });
        continue;
      }
      if (!force && lead.photos_scraped_at) {
        broadcast({ type: 'log', message: `⏭ ${lead.name} — photos already scraped, skipping` }, 'photos');
        results.push({ id, name: lead.name, count: 0 });
        continue;
      }
      broadcast({ type: 'log', message: `📷 [${++done}/${ids.length}] ${lead.name}`, current: done, total: ids.length }, 'photos');
      try {
        const photos = await scrapeMapPhotos(lead.maps_url, Number(max) || 20);
        await savePhotos(id, photos);
        broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${photos.length} photo(s)` }, 'photos');
        results.push({ id, name: lead.name, count: photos.length });
      } catch (err) {
        broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'photos');
        results.push({ id, name: lead.name, count: 0, error: String(err) });
      }
    }
  }));

  broadcast({ type: 'done', message: `📷 Photo scrape complete — ${results.filter(r => !r.error).length}/${ids.length} done` }, 'photos');
  res.json({ results });
});

// ── High-Impact bulk scraper ──────────────────────────────────────────────────
// Phase 1: detail scrape → Phase 2: website + reviews + photos all in PARALLEL
app.post('/api/scrape/high-impact-bulk', async (req, res) => {
  const { ids, workers = 5, force = false } = req.body as { ids: number[]; workers?: number; force?: boolean };
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
  const w  = Math.min(Math.max(Number(workers) || 5, 1), 8);
  const w2 = Math.max(Math.floor(w / 2), 2); // workers per parallel phase-2 scraper
  secondaryShouldStop = false;

  broadcast({ type: 'start', message: `⚡ High-Impact: ${ids.length} leads · Phase 1: Details (${w} workers)`, total: ids.length }, 'detail');

  // ── Phase 1: Detail scrape ─────────────────────────────────────────────────
  let d1 = 0;
  const dq = [...ids];
  await Promise.all(Array.from({ length: Math.min(w, ids.length) }, async () => {
    while (!secondaryShouldStop) {
      const rawId = dq.shift(); if (rawId === undefined) break;
      const id = Number(rawId);
      const lead = await getLeadById(id);
      if (!lead?.maps_url) { broadcast({ type: 'log', message: `⏭ #${id} — no Maps URL` }, 'detail'); continue; }
      if (!force && lead.details_scraped) { broadcast({ type: 'log', message: `⏭ ${lead.name} — already scraped` }, 'detail'); d1++; continue; }
      broadcast({ type: 'log', message: `🔍 [${++d1}/${ids.length}] ${lead.name}`, current: d1, total: ids.length }, 'detail');
      try {
        const details = await scrapeDetails(lead.maps_url);
        await saveDetails(id, details);
        const parts = [];
        if (details.phone)      parts.push(`☎ ${details.phone}`);
        if (details.websiteUrl) parts.push(`🌐 ${details.websiteUrl}`);
        broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${parts.join(' | ') || 'scraped'}` }, 'detail');
      } catch (err) {
        broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'detail');
      }
    }
  }));
  broadcast({ type: 'done', message: `⚡ Phase 1 complete — ${d1}/${ids.length} details processed` }, 'detail');

  if (secondaryShouldStop) {
    broadcast({ type: 'log', message: '🛑 High-Impact stopped after Phase 1' }, 'detail');
    res.json({ ok: true, stopped: true }); return;
  }

  // ── Phase 2: Website + Reviews + Photos in PARALLEL ───────────────────────
  broadcast({ type: 'start', message: `⚡ Phase 2: Website · Reviews · Photos in parallel (${w2} workers each)`, total: ids.length }, 'website');
  broadcast({ type: 'start', message: `⚡ Phase 2: Running parallel alongside website`, total: ids.length }, 'reviews');
  broadcast({ type: 'start', message: `⚡ Phase 2: Running parallel alongside website`, total: ids.length }, 'photos');

  const runWebsitePhase = async () => {
    let wn = 0; const q = [...ids];
    await Promise.all(Array.from({ length: Math.min(w2, ids.length) }, async () => {
      while (!secondaryShouldStop) {
        const rawId = q.shift(); if (rawId === undefined) break;
        const id = Number(rawId);
        const lead = await getLeadById(id); if (!lead) continue;
        if (!lead.website_url) {
          await saveWebsiteData(id, { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, status: 'no_website' });
          continue;
        }
        if (!force && lead.website_scrape_status === 'done') { broadcast({ type: 'log', message: `⏭ ${lead.name} — website done` }, 'website'); continue; }
        broadcast({ type: 'log', message: `🌐 [${++wn}/${ids.length}] ${lead.name}`, current: wn, total: ids.length }, 'website');
        try {
          const data = await scrapeWebsite(lead.website_url);
          await saveWebsiteData(id, { ...data, status: 'done' });
          const p: string[] = [];
          if (data.emails.length) p.push(`📧 ${data.emails.length}`);
          if (data.phones.length) p.push(`📞 ${data.phones.length}`);
          broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${p.join(' | ') || 'done'}` }, 'website');
        } catch (err) {
          await saveWebsiteData(id, { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, status: 'error' });
          broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'website');
        }
      }
    }));
    broadcast({ type: 'done', message: `🌐 Website phase complete (${wn} processed)` }, 'website');
  };

  const runReviewsPhase = async () => {
    let rn = 0; const q = [...ids];
    await Promise.all(Array.from({ length: Math.min(w2, ids.length) }, async () => {
      while (!secondaryShouldStop) {
        const rawId = q.shift(); if (rawId === undefined) break;
        const id = Number(rawId);
        const lead = await getLeadById(id); if (!lead?.maps_url) continue;
        if (!force && lead.review_scrape_status === 'done') { broadcast({ type: 'log', message: `⏭ ${lead.name} — reviews done` }, 'reviews'); continue; }
        broadcast({ type: 'log', message: `⭐ [${++rn}/${ids.length}] ${lead.name}`, current: rn, total: ids.length }, 'reviews');
        try {
          const reviews = await scrapeReviews(lead.maps_url, 50);
          await saveReviews(id, reviews);
          await markReviewScrape(id, 'done');
          broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${reviews.length} review(s)` }, 'reviews');
        } catch (err) {
          await markReviewScrape(id, 'error');
          broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'reviews');
        }
      }
    }));
    broadcast({ type: 'done', message: `⭐ Reviews phase complete (${rn} processed)` }, 'reviews');
  };

  const runPhotosPhase = async () => {
    let pn = 0; const q = [...ids];
    await Promise.all(Array.from({ length: Math.min(w2, ids.length) }, async () => {
      while (!secondaryShouldStop) {
        const rawId = q.shift(); if (rawId === undefined) break;
        const id = Number(rawId);
        const lead = await getLeadById(id); if (!lead?.maps_url) continue;
        if (!force && lead.photos_scraped_at) { broadcast({ type: 'log', message: `⏭ ${lead.name} — photos done` }, 'photos'); continue; }
        broadcast({ type: 'log', message: `📷 [${++pn}/${ids.length}] ${lead.name}`, current: pn, total: ids.length }, 'photos');
        try {
          const photos = await scrapeMapPhotos(lead.maps_url, 20);
          await savePhotos(id, photos);
          broadcast({ type: 'log', message: `  ✅ ${lead.name}: ${photos.length} photo(s)` }, 'photos');
        } catch (err) {
          broadcast({ type: 'error', message: `  ❌ ${lead.name}: ${String(err)}` }, 'photos');
        }
      }
    }));
    broadcast({ type: 'done', message: `📷 Photos phase complete (${pn} processed)` }, 'photos');
  };

  await Promise.all([runWebsitePhase(), runReviewsPhase(), runPhotosPhase()]);

  const finalMsg = secondaryShouldStop
    ? '🛑 High-Impact stopped during Phase 2'
    : `⚡ High-Impact complete — ${ids.length} leads fully enriched`;
  broadcast({ type: secondaryShouldStop ? 'log' : 'done', message: finalMsg }, 'detail');
  res.json({ ok: true, total: ids.length, stopped: secondaryShouldStop });
});

// ── Contact form submitter ────────────────────────────────────────────────────
app.post('/api/leads/submit-forms-bulk', async (req, res) => {
  const { ids, sender } = req.body as {
    ids: number[];
    sender: { name: string; email: string; phone: string; message: string };
  };
  if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
  if (!sender?.name || !sender?.email || !sender?.message) { res.status(400).json({ error: 'sender name, email and message required' }); return; }

  broadcast({ type: 'start', message: `Contact form submit starting - ${ids.length} lead(s)` }, 'forms');
  const results: { id: number; name: string; success: boolean; error?: string }[] = [];
  for (const id of ids) {
    const lead = await getLeadById(id);
    if (!lead?.website_contact_url) {
      broadcast({ type: 'log', message: `#${id} has no contact form URL - skipping` }, 'forms');
      results.push({ id, name: lead?.name ?? '', success: false, error: 'no contact form URL — run Scrape Websites first' });
      continue;
    }
    const result = await submitContactForm(lead.website_contact_url, { ...sender, message: sender.message.replace('{name}', lead.name) });
    if (result.success) {
      await logOutreach({ leadId: id, zip: lead.zip, phone: lead.phone, channel: 'email', message: sender.message });
      broadcast({ type: 'log', message: `Submitted contact form for ${lead.name}` }, 'forms');
    } else {
      broadcast({ type: 'error', message: `Contact form failed for ${lead.name}: ${result.error ?? 'unknown error'}` }, 'forms');
    }
    results.push({
      id,
      name: lead.name,
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
    });
    await new Promise((r) => setTimeout(r, 2000));
  }
  broadcast({ type: 'done', message: `Contact form submit complete - ${results.filter((r) => r.success).length}/${ids.length} successful` }, 'forms');
  res.json({ results });
});

// ── Geo zip picker ────────────────────────────────────────────────────────────

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
  broadcast({ type: 'log', message: scheduleTime ? `SMS schedule set for ${scheduleTime}` : 'SMS schedule cleared' }, 'sms');
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
  if (scraping) { broadcast({ type: 'log', message: '⏰ Scheduled SMS skipped — scraper is running' }, 'sms'); return; }

  broadcast({ type: 'start', message: `⏰ Scheduled SMS send starting — ${pending.length} messages in queue` }, 'sms');

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
      broadcast({ type: 'log', message: '⏰ Scheduled SMS skipped — Pixel not connected' }, 'sms');
      return;
    }
  } catch {
    broadcast({ type: 'log', message: '⏰ Scheduled SMS skipped — ADB error' }, 'sms');
    return;
  }

  let sent = 0; let failed = 0;
  for (const item of pending) {
    try {
      await sendSms(item.lead_id, item.template, item.message || undefined);
      await markSmsQueueItem(item.id, 'sent');
      sent++;
      broadcast({ type: 'log', message: `Scheduled SMS sent for queue item #${item.id}` }, 'sms');
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const msg = String(err);
      await markSmsQueueItem(item.id, 'failed', msg);
      failed++;
      broadcast({ type: 'error', message: `Scheduled SMS failed for queue item #${item.id}: ${msg}` }, 'sms');
      if (msg.includes('not connected') || msg.includes('no devices')) break;
    }
  }
  broadcast({ type: 'done', message: `⏰ Scheduled SMS done — ✅ ${sent} sent · ❌ ${failed} failed` }, 'sms');
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

void initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  MapLeadHunter UI → http://localhost:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error('[db] init failed:', err);
    process.exitCode = 1;
  });

// ── Cross-computer activity feed ─────────────────────────────────────────────
app.get('/api/meta', (_req, res) => {
  res.json({ host: HOST });
});

app.get('/api/activity', async (req, res) => {
  const since = Number((req.query as Record<string, string>)['since'] ?? 0);
  res.json(await getRecentActivity(since));
});

app.get('/api/activity/recent', async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const limit = Number(query['limit'] ?? 200);
  const source = query['source']?.trim() || undefined;
  res.json(await getActivityHistory(limit, source));
});

// ── Active scrape claims (what every computer is doing right now) ─────────────
app.get('/api/scrape/claims', async (_req, res) => {
  const r = await getDb().execute('SELECT zip, category, claimed_by, scraper_type, claimed_at, updated_at FROM scrape_claims');
  res.json(r.rows.map(row => ({
    zip: String(row[0]),
    category: String(row[1]),
    claimed_by: String(row[2]),
    scraper_type: String(row[3]),
    claimed_at: String(row[4]),
    updated_at: String(row[5]),
  })));
});

app.get('/api/scrape/category-status', async (_req, res) => {
  res.json(await getCategoryZipStatuses());
});

// ── Real-time log viewer ─────────────────────────────────────────────────────

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
  if (++lines > 200) { wrap.removeChild(wrap.firstChild); lines--; }
  document.getElementById('end').scrollIntoView({ behavior:'auto' });
}

var es = new EventSource('/logs/stream');
es.onopen = function() { st.textContent = '● live'; st.style.color='#4ade80'; };
es.onmessage = function(e) { addLine(e.data); };
es.onerror = function() { st.textContent = '○ reconnecting…'; st.style.color='#fb923c'; };
</script></body></html>`);
});

// SSE stream of log file lines (tail -f style)
app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const LOG_FILE = (() => {
    // Match where app-main.cjs writes: userData/logs/app.log
    // userData on Windows: %APPDATA%\MapLeadHunter
    const appData = process.env['APPDATA'] || os.homedir();
    return path.join(appData, 'MapLeadHunter', 'logs', 'app.log');
  })();

  const send = (line: string) => res.write(`data: ${line.replace(/\r?\n/g, ' ')}\n\n`);

  // Send last 200 lines immediately (tail)
  if (existsSync(LOG_FILE)) {
    try {
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
    const fd = openSync(LOG_FILE, 'r');
    readSync(fd, chunk, 0, chunk.length, lastSize);
    closeSync(fd);
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
  broadcast({ type: 'start', message: 'Google Sheets backup starting' });
  try {
    const result = await backupToSheets();
    broadcast({ type: 'done', message: `Google Sheets backup done - ${result.rows} row(s)` });
    res.json({ ok: true, ...result });
  } catch (err) {
    broadcast({ type: 'error', message: `Google Sheets backup failed: ${String(err)}` });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

