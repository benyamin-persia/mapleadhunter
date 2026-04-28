import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

export interface Lead {
  id: number;
  created_at: string;
  updated_at: string;
  zip: string;
  phone: string;
  name: string;
  address: string;
  category: string;
  rating: number | null;
  review_count: number | null;
  price_level: string;
  open_now: string;
  maps_url: string;
  website_url: string;
  has_website: 0 | 1;
  hours: string;
  description: string;
  amenities: string;
  social_links: string;
  menu_url: string;
  booking_url: string;
  service_area: string;
  plus_code: string;
  details_scraped: 0 | 1;
  reviews_scraped_at: string;
  review_scrape_status: string;
  website_emails: string;
  website_phones: string;
  website_contact_url: string;
  website_scraped_at: string;
  website_scrape_status: string;
  scrape_method: string;
  maps_thumbnail: string;
  website_og_image: string;
  maps_photos: string;
  photos_scraped_at: string;
}

export type LeadListItem = Pick<Lead,
  'id' | 'created_at' | 'updated_at' | 'zip' | 'phone' | 'name' | 'address' | 'category' |
  'rating' | 'review_count' | 'price_level' | 'open_now' | 'maps_url' | 'website_url' |
  'has_website' | 'details_scraped' | 'reviews_scraped_at' | 'review_scrape_status' |
  'website_emails' | 'website_phones' | 'website_contact_url' | 'website_scraped_at' |
  'website_scrape_status' | 'scrape_method' | 'maps_thumbnail' | 'website_og_image' |
  'photos_scraped_at'
>;

export interface NewLead {
  zip: string;
  phone: string;
  name: string;
  address: string;
  category: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string;
  openNow: string;
  maps_url: string;
  website_url: string;
  has_website: boolean;
  scrape_method?: string;
  maps_thumbnail?: string;
}

function row<T>(r: unknown): T { return r as unknown as T; }

export interface ActivityRow {
  id: number;
  created_at: string;
  host: string;
  type: string;
  message: string;
  source: string;
}

export async function insertLeads(leads: NewLead[]): Promise<number> {
  const db = getDb();
  let count = 0;
  for (const l of leads) {
    // INSERT OR IGNORE gives rowsAffected=1 for new rows, 0 for conflicts — accurate per-row, concurrency-safe
    const r = await db.execute({
      sql: `INSERT OR IGNORE INTO leads
              (zip, phone, name, address, category, rating, review_count, price_level, open_now,
               maps_url, website_url, has_website, scrape_method, maps_thumbnail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        l.zip, l.phone, l.name, l.address, l.category,
        l.rating, l.reviewCount, l.priceLevel, l.openNow,
        l.maps_url, l.website_url, l.has_website ? 1 : 0,
        l.scrape_method ?? 'fast',
        l.maps_thumbnail ?? '',
      ],
    });
    if (r.rowsAffected > 0) {
      count++;
    } else {
      // Existing record — enrich phone/thumbnail if the new scrape has better data
      await db.execute({
        sql: `UPDATE leads SET
                phone = CASE WHEN phone = '' AND ? != '' THEN ? ELSE phone END,
                maps_thumbnail = CASE WHEN ? != '' THEN ? ELSE maps_thumbnail END,
                updated_at = CASE WHEN phone = '' AND ? != '' THEN datetime('now') ELSE updated_at END
              WHERE maps_url = ?`,
        args: [l.phone, l.phone, l.maps_thumbnail ?? '', l.maps_thumbnail ?? '', l.phone, l.maps_url],
      });
    }
  }
  logger.info({ inserted: count, total: leads.length }, 'leads saved');
  return count;
}

export async function getLeadById(id: number): Promise<Lead | undefined> {
  const r = await getDb().execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [id] });
  return r.rows[0] ? row<Lead>(r.rows[0]) : undefined;
}

export async function getLeadByMapsUrl(mapsUrl: string): Promise<Lead | undefined> {
  const r = await getDb().execute({ sql: 'SELECT * FROM leads WHERE maps_url = ?', args: [mapsUrl] });
  return r.rows[0] ? row<Lead>(r.rows[0]) : undefined;
}

export async function getAllLeads(): Promise<Lead[]> {
  const r = await getDb().execute('SELECT * FROM leads ORDER BY created_at DESC');
  return r.rows.map(row<Lead>);
}

export async function getLeadList(): Promise<LeadListItem[]> {
  const r = await getDb().execute(`
    SELECT
      id, created_at, updated_at, zip, phone, name, address, category,
      rating, review_count, price_level, open_now, maps_url, website_url,
      has_website, details_scraped, reviews_scraped_at, review_scrape_status,
      website_emails, website_phones, website_contact_url, website_scraped_at,
      website_scrape_status, scrape_method, maps_thumbnail, website_og_image,
      photos_scraped_at
    FROM leads
    ORDER BY created_at DESC
  `);
  return r.rows.map(row<LeadListItem>);
}

export async function getLeadCount(): Promise<number> {
  const r = await getDb().execute('SELECT COUNT(*) FROM leads');
  return Number(r.rows[0]?.[0] ?? 0);
}

export async function deleteLeads(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  await getDb().execute({ sql: `DELETE FROM leads WHERE id IN (${placeholders})`, args: ids });
}

export async function deleteAllLeads(): Promise<void> {
  await getDb().execute('DELETE FROM leads');
}

export async function saveDetails(leadId: number, d: {
  phone?: string;
  address?: string;
  websiteUrl?: string;
  hasWebsite?: boolean;
  hours: Record<string, string>;
  description: string;
  amenities: string[];
  socialLinks: { platform: string; url: string }[];
  menuUrl: string;
  bookingUrl: string;
  serviceArea: string;
  plusCode: string;
}): Promise<void> {
  await getDb().execute({
    sql: `UPDATE leads SET
            phone = CASE WHEN ? != '' THEN ? ELSE phone END,
            address = CASE WHEN ? != '' THEN ? ELSE address END,
            website_url = CASE WHEN ? != '' THEN ? ELSE website_url END,
            has_website = CASE WHEN ? = 1 THEN 1 ELSE has_website END,
            hours = ?, description = ?, amenities = ?, social_links = ?,
            menu_url = ?, booking_url = ?, service_area = ?, plus_code = ?,
            details_scraped = 1, updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      d.phone ?? '', d.phone ?? '',
      d.address ?? '', d.address ?? '',
      d.websiteUrl ?? '', d.websiteUrl ?? '',
      d.hasWebsite ? 1 : 0,
      JSON.stringify(d.hours), d.description,
      JSON.stringify(d.amenities), JSON.stringify(d.socialLinks),
      d.menuUrl, d.bookingUrl, d.serviceArea, d.plusCode,
      leadId,
    ],
  });
}

export interface Review {
  id: number;
  lead_id: number;
  reviewer_name: string;
  reviewer_url: string;
  reviewer_rating: number | null;
  review_date: string;
  review_text: string;
  created_at: string;
}

export async function saveReviews(leadId: number, reviews: { reviewerName: string; reviewerUrl?: string; reviewerRating: number | null; reviewDate: string; reviewText: string }[]): Promise<void> {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM reviews WHERE lead_id = ?', args: [leadId] });
  for (const r of reviews) {
    await db.execute({
      sql: 'INSERT INTO reviews (lead_id, reviewer_name, reviewer_url, reviewer_rating, review_date, review_text) VALUES (?, ?, ?, ?, ?, ?)',
      args: [leadId, r.reviewerName, r.reviewerUrl ?? '', r.reviewerRating, r.reviewDate, r.reviewText],
    });
  }
}

export async function getReviews(leadId: number): Promise<Review[]> {
  const r = await getDb().execute({ sql: 'SELECT * FROM reviews WHERE lead_id = ? ORDER BY id', args: [leadId] });
  return r.rows.map(row<Review>);
}

export async function markReviewScrape(leadId: number, status: 'done' | 'error'): Promise<void> {
  await getDb().execute({
    sql: `UPDATE leads SET review_scrape_status = ?, reviews_scraped_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    args: [status, leadId],
  });
}

export async function saveWebsiteData(leadId: number, d: {
  emails: string[];
  phones: string[];
  socialLinks: { platform: string; url: string }[];
  contactUrl: string;
  hasContactForm: boolean;
  status: 'done' | 'error' | 'no_website';
  ogImage?: string;
}): Promise<void> {
  await getDb().execute({
    sql: `UPDATE leads SET
            website_emails = ?,
            website_phones = ?,
            social_links = CASE WHEN ? != '[]' THEN ? ELSE social_links END,
            website_contact_url = ?,
            website_og_image = CASE WHEN ? != '' THEN ? ELSE website_og_image END,
            website_scraped_at = datetime('now'),
            website_scrape_status = ?,
            updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      JSON.stringify(d.emails),
      JSON.stringify(d.phones),
      JSON.stringify(d.socialLinks), JSON.stringify(d.socialLinks),
      d.contactUrl,
      d.ogImage ?? '', d.ogImage ?? '',
      d.status,
      leadId,
    ],
  });
}

export async function savePhotos(leadId: number, photos: string[]): Promise<void> {
  await getDb().execute({
    sql: `UPDATE leads SET maps_photos = ?, photos_scraped_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    args: [JSON.stringify(photos), leadId],
  });
}

export async function logOutreach(opts: {
  leadId: number; zip: string; phone: string; channel: 'sms' | 'email'; message: string;
}): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO outreach_log (lead_id, zip, phone, channel, message) VALUES (?, ?, ?, ?, ?)`,
    args: [opts.leadId, opts.zip, opts.phone, opts.channel, opts.message],
  });
  logger.info({ leadId: opts.leadId, channel: opts.channel }, 'outreach logged');
}

export interface SmsQueueItem {
  id: number; created_at: string; lead_id: number; template: string; message: string;
  status: 'pending' | 'sent' | 'failed'; sent_at: string; error: string;
  name?: string; phone?: string;
}

export async function enqueueSmsBatch(items: { leadId: number; template: string; message: string }[]): Promise<number> {
  const db = getDb();
  for (const item of items) {
    await db.execute({
      sql: 'INSERT INTO sms_queue (lead_id, template, message) VALUES (?, ?, ?)',
      args: [item.leadId, item.template, item.message],
    });
  }
  return items.length;
}

export async function getSmsQueue(status?: string): Promise<SmsQueueItem[]> {
  const db = getDb();
  const sql = status
    ? `SELECT q.*, l.name, l.phone FROM sms_queue q LEFT JOIN leads l ON l.id = q.lead_id WHERE q.status = ? ORDER BY q.id`
    : `SELECT q.*, l.name, l.phone FROM sms_queue q LEFT JOIN leads l ON l.id = q.lead_id ORDER BY q.id DESC`;
  const r = status
    ? await db.execute({ sql, args: [status] })
    : await db.execute(sql);
  return r.rows.map(row<SmsQueueItem>);
}

export async function markSmsQueueItem(id: number, status: 'sent' | 'failed', error = ''): Promise<void> {
  await getDb().execute({
    sql: `UPDATE sms_queue SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE '' END, error = ? WHERE id = ?`,
    args: [status, status, error, id],
  });
}

export async function clearSmsQueue(status?: 'sent' | 'failed'): Promise<void> {
  if (status) {
    await getDb().execute({ sql: 'DELETE FROM sms_queue WHERE status = ?', args: [status] });
  } else {
    await getDb().execute('DELETE FROM sms_queue');
  }
}

export async function markZipScraped(zip: string, category: string, leadsFound: number, scrapeMethod = 'maps_fast'): Promise<void> {
  await getDb().execute({
    sql: `INSERT OR REPLACE INTO scraped_zips (zip, category, scrape_method, scraped_at, leads_found) VALUES (?, ?, ?, datetime('now'), ?)`,
    args: [zip, category.toLowerCase(), scrapeMethod, leadsFound],
  });
}

export async function logActivity(host: string, type: string, message: string, source = 'main'): Promise<void> {
  await getDb().execute({ sql: `INSERT INTO scrape_activity (host, type, message, source) VALUES (?, ?, ?, ?)`, args: [host, type, message, source] });
}

function activityRow(rowData: unknown): ActivityRow {
  const cells = rowData as Record<number, unknown>;
  return {
    id: Number(cells[0]),
    created_at: String(cells[1]),
    host: String(cells[2]),
    type: String(cells[3]),
    message: String(cells[4]),
    source: String(cells[5]),
  };
}

export async function getRecentActivity(sinceId = 0): Promise<ActivityRow[]> {
  const r = await getDb().execute({ sql: `SELECT * FROM scrape_activity WHERE id > ? ORDER BY id ASC`, args: [sinceId] });
  return r.rows.map(activityRow);
}

export async function getActivityHistory(limit = 200, source?: string): Promise<ActivityRow[]> {
  const cappedLimit = Math.min(Math.max(Math.floor(limit) || 200, 1), 2000);
  const sql = source
    ? `SELECT * FROM (SELECT * FROM scrape_activity WHERE source = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
    : `SELECT * FROM (SELECT * FROM scrape_activity ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
  const args = source ? [source, cappedLimit] : [cappedLimit];
  const r = await getDb().execute({ sql, args });
  return r.rows.map(activityRow);
}

// Atomically claim a zip for scraping — returns true if claimed, false if already taken
export async function claimZip(zip: string, category: string, workerId: string, scraperType = 'maps'): Promise<boolean> {
  const db = getDb();
  const normalizedCategory = category.toLowerCase();
  try {
    await db.execute({
      sql: `INSERT INTO scrape_claims (zip, category, claimed_by, scraper_type, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`,
      args: [zip, normalizedCategory, workerId, scraperType],
    });
    return true;
  } catch {
    const host = workerId.split(':')[0] ?? workerId;
    const existing = await db.execute({
      sql: `SELECT claimed_by FROM scrape_claims WHERE zip = ? AND category = ?`,
      args: [zip, normalizedCategory],
    });
    const claimedBy = String(existing.rows[0]?.[0] ?? '');
    if (claimedBy.startsWith(`${host}:`)) {
      await db.execute({ sql: `DELETE FROM scrape_claims WHERE zip = ? AND category = ?`, args: [zip, normalizedCategory] });
      await db.execute({
        sql: `INSERT INTO scrape_claims (zip, category, claimed_by, scraper_type, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`,
        args: [zip, normalizedCategory, workerId, scraperType],
      });
      return true;
    }
    return false; // already claimed by another computer
  }
}

export async function releaseZip(zip: string, category: string): Promise<void> {
  await getDb().execute({ sql: `DELETE FROM scrape_claims WHERE zip = ? AND category = ?`, args: [zip, category.toLowerCase()] });
}

// Release claims older than 2 hours (stale crash recovery)
export async function releaseStaleZipClaims(): Promise<void> {
  await getDb().execute(`DELETE FROM scrape_claims WHERE claimed_at < datetime('now', '-2 hours')`);
}

export async function getScrapedZipSet(scrapeMethod?: string): Promise<Set<string>> {
  const r = scrapeMethod
    ? await getDb().execute({ sql: 'SELECT zip, category FROM scraped_zips WHERE scrape_method = ?', args: [scrapeMethod] })
    : await getDb().execute('SELECT zip, category FROM scraped_zips');
  return new Set(r.rows.map((row) => `${row[0]}::${row[1]}`));
}

export interface CategoryZipStatus {
  zip: string;
  category: string;
  scrapedCount: number;
  attemptCount: number;
  failedCount: number;
  skippedCount: number;
  leadsFound: number;
  lastScraper: string;
  lastHost: string;
  lastScrapedAt: string;
}

export async function getCategoryZipStatuses(): Promise<CategoryZipStatus[]> {
  const statuses = new Map<string, CategoryZipStatus>();
  const getStatus = (zip: string, category: string): CategoryZipStatus => {
    const key = `${zip}::${category.toLowerCase()}`;
    const existing = statuses.get(key);
    if (existing) return existing;
    const next: CategoryZipStatus = {
      zip,
      category: category.toLowerCase(),
      scrapedCount: 0,
      attemptCount: 0,
      failedCount: 0,
      skippedCount: 0,
      leadsFound: 0,
      lastScraper: '',
      lastHost: '',
      lastScrapedAt: '',
    };
    statuses.set(key, next);
    return next;
  };

  const scraped = await getDb().execute('SELECT zip, category, scrape_method, scraped_at, leads_found FROM scraped_zips');
  const fallbackDoneKeys = new Set<string>();
  for (const rowData of scraped.rows) {
    const cells = rowData as Record<number, unknown>;
    const zip = String(cells[0] ?? '');
    const category = String(cells[1] ?? '').toLowerCase();
    if (!zip || !category) continue;
    const status = getStatus(zip, category);
    fallbackDoneKeys.add(`${zip}::${category}`);
    status.leadsFound = Number(cells[4] ?? status.leadsFound);
    const scrapedAt = String(cells[3] ?? '');
    if (scrapedAt >= status.lastScrapedAt) {
      status.lastScrapedAt = scrapedAt;
      status.lastScraper = String(cells[2] ?? status.lastScraper);
      status.lastHost = status.lastHost || 'unknown';
    }
  }

  const runItems = await getDb().execute(`
    SELECT i.zip, i.category, i.scraper_type, i.status, i.attempts, i.finished_at, i.started_at, r.host, r.updated_at
    FROM scrape_run_items i
    LEFT JOIN scrape_runs r ON r.id = i.run_id
    ORDER BY i.id ASC
  `);
  for (const rowData of runItems.rows) {
    const cells = rowData as Record<number, unknown>;
    const zip = String(cells[0] ?? '');
    const category = String(cells[1] ?? '').toLowerCase();
    if (!zip || !category) continue;
    const status = getStatus(zip, category);
    const itemStatus = String(cells[3] ?? '');
    const attempts = Math.max(Number(cells[4] ?? 0), itemStatus === 'pending' ? 0 : 1);
    status.attemptCount += attempts;
    if (itemStatus === 'done') status.scrapedCount++;
    if (itemStatus === 'failed') status.failedCount++;
    if (itemStatus === 'skipped') status.skippedCount++;

    const finishedAt = String(cells[5] ?? '');
    const startedAt = String(cells[6] ?? '');
    const updatedAt = String(cells[8] ?? '');
    const lastAt = finishedAt || startedAt || updatedAt;
    if (lastAt >= status.lastScrapedAt) {
      status.lastScrapedAt = lastAt;
      status.lastScraper = String(cells[2] ?? status.lastScraper);
      status.lastHost = String(cells[7] ?? status.lastHost);
    }
  }

  for (const key of fallbackDoneKeys) {
    const status = statuses.get(key);
    if (status && status.scrapedCount === 0) status.scrapedCount = 1;
  }

  return [...statuses.values()].sort((a, b) => a.category.localeCompare(b.category) || a.zip.localeCompare(b.zip));
}

export interface ScrapeRun {
  id: string;
  created_at: string;
  updated_at: string;
  host: string;
  scraper_type: string;
  status: 'pending' | 'running' | 'paused' | 'stopped' | 'done' | 'failed';
  total_items: number;
  completed_items: number;
  failed_items: number;
  skipped_items: number;
  found: number;
  saved: number;
  duplicates: number;
  request_json: string;
  cursor_json: string;
  last_message: string;
}

export interface ScrapeRunItem {
  id: number;
  run_id: string;
  scraper_type: string;
  zip: string;
  category: string;
  lead_id: number | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  started_at: string;
  finished_at: string;
  last_error: string;
  result_json: string;
}

export async function createScrapeRun(opts: {
  host: string;
  scraperType: string;
  request: unknown;
  items: { zip: string; category: string; scraperType?: string; leadId?: number | null }[];
}): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  await db.batch([
    {
      sql: `INSERT INTO scrape_runs
              (id, host, scraper_type, status, total_items, request_json, last_message)
            VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      args: [id, opts.host, opts.scraperType, opts.items.length, JSON.stringify(opts.request), 'Created scrape run'],
    },
    ...opts.items.map((item) => ({
      sql: `INSERT INTO scrape_run_items (run_id, scraper_type, zip, category, lead_id)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, item.scraperType ?? opts.scraperType, item.zip, item.category.toLowerCase(), item.leadId ?? null],
    })),
  ], 'write');
  return id;
}

export async function updateScrapeRun(id: string, patch: {
  status?: ScrapeRun['status'];
  completedDelta?: number;
  failedDelta?: number;
  skippedDelta?: number;
  foundDelta?: number;
  savedDelta?: number;
  duplicatesDelta?: number;
  cursor?: unknown;
  message?: string;
}): Promise<void> {
  await getDb().execute({
    sql: `UPDATE scrape_runs SET
            status = COALESCE(?, status),
            completed_items = completed_items + ?,
            failed_items = failed_items + ?,
            skipped_items = skipped_items + ?,
            found = found + ?,
            saved = saved + ?,
            duplicates = duplicates + ?,
            cursor_json = CASE WHEN ? != '' THEN ? ELSE cursor_json END,
            last_message = CASE WHEN ? != '' THEN ? ELSE last_message END,
            updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      patch.status ?? null,
      patch.completedDelta ?? 0,
      patch.failedDelta ?? 0,
      patch.skippedDelta ?? 0,
      patch.foundDelta ?? 0,
      patch.savedDelta ?? 0,
      patch.duplicatesDelta ?? 0,
      patch.cursor === undefined ? '' : JSON.stringify(patch.cursor),
      patch.cursor === undefined ? '' : JSON.stringify(patch.cursor),
      patch.message ?? '',
      patch.message ?? '',
      id,
    ],
  });
}

export async function markScrapeRunItem(runId: string, zip: string, category: string, status: ScrapeRunItem['status'], result: unknown = {}, error = ''): Promise<void> {
  await getDb().execute({
    sql: `UPDATE scrape_run_items SET
            status = ?,
            attempts = CASE WHEN ? = 'running' THEN attempts + 1 ELSE attempts END,
            started_at = CASE WHEN ? = 'running' THEN datetime('now') ELSE started_at END,
            finished_at = CASE WHEN ? IN ('done','failed','skipped') THEN datetime('now') ELSE finished_at END,
            last_error = ?,
            result_json = ? 
          WHERE run_id = ? AND zip = ? AND category = ?`,
    args: [status, status, status, status, error, JSON.stringify(result), runId, zip, category.toLowerCase()],
  });
}

export async function getLatestResumableScrapeRun(): Promise<ScrapeRun | undefined> {
  const r = await getDb().execute(
    `SELECT * FROM scrape_runs
     WHERE status IN ('pending','running','paused','stopped','failed')
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  return r.rows[0] ? row<ScrapeRun>(r.rows[0]) : undefined;
}

export async function getScrapeRun(id: string): Promise<ScrapeRun | undefined> {
  const r = await getDb().execute({ sql: `SELECT * FROM scrape_runs WHERE id = ?`, args: [id] });
  return r.rows[0] ? row<ScrapeRun>(r.rows[0]) : undefined;
}

export async function getPendingScrapeRunItems(runId: string): Promise<ScrapeRunItem[]> {
  const r = await getDb().execute({
    sql: `SELECT * FROM scrape_run_items
          WHERE run_id = ? AND status IN ('pending','running','failed')
          ORDER BY id ASC`,
    args: [runId],
  });
  return r.rows.map(row<ScrapeRunItem>);
}

export async function getOutreachLog(): Promise<unknown[]> {
  const r = await getDb().execute(
    `SELECT o.*, l.name FROM outreach_log o JOIN leads l ON l.id = o.lead_id ORDER BY o.created_at DESC`
  );
  return r.rows.map(row<unknown>);
}
