import { getDb } from './db.js';
import { logger } from '../utils/logger.js';

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

export async function insertLeads(leads: NewLead[]): Promise<number> {
  const db = getDb();
  let count = 0;
  for (const l of leads) {
    const result = await db.execute({
      sql: `INSERT INTO leads
              (zip, phone, name, address, category, rating, review_count, price_level, open_now,
               maps_url, website_url, has_website, scrape_method, maps_thumbnail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(maps_url) DO UPDATE SET
              phone = CASE WHEN leads.phone = '' AND excluded.phone != '' THEN excluded.phone ELSE leads.phone END,
              maps_thumbnail = CASE WHEN excluded.maps_thumbnail != '' THEN excluded.maps_thumbnail ELSE leads.maps_thumbnail END,
              updated_at = CASE WHEN leads.phone = '' AND excluded.phone != '' THEN datetime('now') ELSE leads.updated_at END`,
      args: [
        l.zip, l.phone, l.name, l.address, l.category,
        l.rating, l.reviewCount, l.priceLevel, l.openNow,
        l.maps_url, l.website_url, l.has_website ? 1 : 0,
        l.scrape_method ?? 'fast',
        l.maps_thumbnail ?? '',
      ],
    });
    if (result.rowsAffected > 0) count++;
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

export async function markZipScraped(zip: string, category: string, leadsFound: number): Promise<void> {
  await getDb().execute({
    sql: `INSERT OR REPLACE INTO scraped_zips (zip, category, scraped_at, leads_found) VALUES (?, ?, datetime('now'), ?)`,
    args: [zip, category.toLowerCase(), leadsFound],
  });
}

export async function logActivity(host: string, type: string, message: string, source = 'main'): Promise<void> {
  await getDb().execute({ sql: `INSERT INTO scrape_activity (host, type, message, source) VALUES (?, ?, ?, ?)`, args: [host, type, message, source] });
  // Keep only last 500 events
  await getDb().execute(`DELETE FROM scrape_activity WHERE id NOT IN (SELECT id FROM scrape_activity ORDER BY id DESC LIMIT 500)`);
}

export async function getRecentActivity(sinceId = 0): Promise<{ id: number; created_at: string; host: string; type: string; message: string; source: string }[]> {
  const r = await getDb().execute({ sql: `SELECT * FROM scrape_activity WHERE id > ? ORDER BY id ASC`, args: [sinceId] });
  return r.rows.map(row => ({
    id: Number(row[0]), created_at: String(row[1]), host: String(row[2]),
    type: String(row[3]), message: String(row[4]), source: String(row[5]),
  }));
}

// Atomically claim a zip for scraping — returns true if claimed, false if already taken
export async function claimZip(zip: string, category: string, workerId: string): Promise<boolean> {
  try {
    await getDb().execute({
      sql: `INSERT INTO scrape_claims (zip, category, claimed_by) VALUES (?, ?, ?)`,
      args: [zip, category.toLowerCase(), workerId],
    });
    return true;
  } catch {
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

export async function getScrapedZipSet(): Promise<Set<string>> {
  const r = await getDb().execute('SELECT zip, category FROM scraped_zips');
  return new Set(r.rows.map((row) => `${row[0]}::${row[1]}`));
}

export async function getOutreachLog(): Promise<unknown[]> {
  const r = await getDb().execute(
    `SELECT o.*, l.name FROM outreach_log o JOIN leads l ON l.id = o.lead_id ORDER BY o.created_at DESC`
  );
  return r.rows.map(row<unknown>);
}
