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
}

export function insertLeads(leads: NewLead[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO leads
      (zip, phone, name, address, category, rating, review_count, price_level, open_now, maps_url, website_url, has_website, scrape_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(maps_url) DO UPDATE SET
      phone = CASE WHEN leads.phone = '' AND excluded.phone != '' THEN excluded.phone ELSE leads.phone END,
      updated_at = CASE WHEN leads.phone = '' AND excluded.phone != '' THEN datetime('now') ELSE leads.updated_at END
  `);

  let count = 0;
  for (const l of leads) {
    const result = stmt.run(
      l.zip, l.phone, l.name, l.address, l.category,
      l.rating, l.reviewCount, l.priceLevel, l.openNow,
      l.maps_url, l.website_url, l.has_website ? 1 : 0,
      l.scrape_method ?? 'fast',
    );
    if (result.changes > 0) count++;
  }

  logger.info({ inserted: count, total: leads.length }, 'leads saved');
  return count;
}

export function getLeadById(id: number): Lead | undefined {
  return getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as Lead | undefined;
}

export function getLeadByMapsUrl(mapsUrl: string): Lead | undefined {
  return getDb().prepare('SELECT * FROM leads WHERE maps_url = ?').get(mapsUrl) as unknown as Lead | undefined;
}

export function getAllLeads(): Lead[] {
  return getDb().prepare('SELECT * FROM leads ORDER BY created_at DESC').all() as unknown as Lead[];
}

export function deleteLeads(ids: number[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  // node:sqlite run() accepts SQLInputValue spread; cast via any to bypass strict generic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getDb().prepare(`DELETE FROM leads WHERE id IN (${placeholders})`) as any).run(...ids);
}

export function saveDetails(leadId: number, d: {
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
}): void {
  getDb().prepare(`
    UPDATE leads SET
      phone = CASE WHEN ? != '' THEN ? ELSE phone END,
      address = CASE WHEN ? != '' THEN ? ELSE address END,
      website_url = CASE WHEN ? != '' THEN ? ELSE website_url END,
      has_website = CASE WHEN ? = 1 THEN 1 ELSE has_website END,
      hours = ?, description = ?, amenities = ?, social_links = ?,
      menu_url = ?, booking_url = ?, service_area = ?, plus_code = ?,
      details_scraped = 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    d.phone ?? '',
    d.phone ?? '',
    d.address ?? '',
    d.address ?? '',
    d.websiteUrl ?? '',
    d.websiteUrl ?? '',
    d.hasWebsite ? 1 : 0,
    JSON.stringify(d.hours),
    d.description,
    JSON.stringify(d.amenities),
    JSON.stringify(d.socialLinks),
    d.menuUrl,
    d.bookingUrl,
    d.serviceArea,
    d.plusCode,
    leadId,
  );
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

export function saveReviews(leadId: number, reviews: { reviewerName: string; reviewerUrl?: string; reviewerRating: number | null; reviewDate: string; reviewText: string }[]): void {
  const db = getDb();
  db.prepare('DELETE FROM reviews WHERE lead_id = ?').run(leadId);
  const stmt = db.prepare('INSERT INTO reviews (lead_id, reviewer_name, reviewer_url, reviewer_rating, review_date, review_text) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of reviews) {
    stmt.run(leadId, r.reviewerName, r.reviewerUrl ?? '', r.reviewerRating, r.reviewDate, r.reviewText);
  }
}

export function getReviews(leadId: number): Review[] {
  return getDb().prepare('SELECT * FROM reviews WHERE lead_id = ? ORDER BY id').all(leadId) as unknown as Review[];
}

export function markReviewScrape(leadId: number, status: 'done' | 'error'): void {
  getDb()
    .prepare("UPDATE leads SET review_scrape_status = ?, reviews_scraped_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(status, leadId);
}

export function saveWebsiteData(leadId: number, d: {
  emails: string[];
  phones: string[];
  socialLinks: { platform: string; url: string }[];
  contactUrl: string;
  hasContactForm: boolean;
  status: 'done' | 'error' | 'no_website';
}): void {
  getDb().prepare(`
    UPDATE leads SET
      website_emails = ?,
      website_phones = ?,
      social_links = CASE WHEN ? != '[]' THEN ? ELSE social_links END,
      website_contact_url = ?,
      website_scraped_at = datetime('now'),
      website_scrape_status = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(d.emails),
    JSON.stringify(d.phones),
    JSON.stringify(d.socialLinks),
    JSON.stringify(d.socialLinks),
    d.contactUrl,
    d.status,
    leadId,
  );
}

export function logOutreach(opts: {
  leadId: number;
  zip: string;
  phone: string;
  channel: 'sms' | 'email';
  message: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO outreach_log (lead_id, zip, phone, channel, message)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(opts.leadId, opts.zip, opts.phone, opts.channel, opts.message);

  logger.info({ leadId: opts.leadId, channel: opts.channel }, 'outreach logged');
}

export interface SmsQueueItem {
  id: number;
  created_at: string;
  lead_id: number;
  template: string;
  message: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at: string;
  error: string;
  name?: string;
  phone?: string;
}

export function enqueueSmsBatch(items: { leadId: number; template: string; message: string }[]): number {
  const stmt = getDb().prepare('INSERT INTO sms_queue (lead_id, template, message) VALUES (?, ?, ?)');
  let count = 0;
  for (const item of items) {
    stmt.run(item.leadId, item.template, item.message);
    count++;
  }
  return count;
}

export function getSmsQueue(status?: string): SmsQueueItem[] {
  const sql = status
    ? `SELECT q.*, l.name, l.phone FROM sms_queue q LEFT JOIN leads l ON l.id = q.lead_id WHERE q.status = ? ORDER BY q.id`
    : `SELECT q.*, l.name, l.phone FROM sms_queue q LEFT JOIN leads l ON l.id = q.lead_id ORDER BY q.id DESC`;
  return (status ? getDb().prepare(sql).all(status) : getDb().prepare(sql).all()) as unknown as SmsQueueItem[];
}

export function markSmsQueueItem(id: number, status: 'sent' | 'failed', error = ''): void {
  getDb().prepare(
    `UPDATE sms_queue SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE '' END, error = ? WHERE id = ?`
  ).run(status, status, error, id);
}

export function clearSmsQueue(status?: 'sent' | 'failed'): void {
  if (status) getDb().prepare('DELETE FROM sms_queue WHERE status = ?').run(status);
  else getDb().exec('DELETE FROM sms_queue');
}
