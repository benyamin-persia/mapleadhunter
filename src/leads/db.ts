import { createClient, type Client } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR   = path.resolve(__dirname, '../../data');
const LOCAL_DB = path.join(DB_DIR, 'leads-sync.db');

const CURRENT_VERSION = 10;

// Full schema for a fresh database — runs in ONE batch (one network call)
const FULL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS _schema (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS leads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    zip              TEXT NOT NULL DEFAULT '',
    phone            TEXT NOT NULL DEFAULT '',
    name             TEXT NOT NULL,
    address          TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL DEFAULT '',
    rating           REAL,
    maps_url         TEXT NOT NULL UNIQUE,
    website_url      TEXT NOT NULL DEFAULT '',
    has_website      INTEGER NOT NULL DEFAULT 0,
    review_count     INTEGER,
    price_level      TEXT NOT NULL DEFAULT '',
    open_now         TEXT NOT NULL DEFAULT '',
    hours            TEXT NOT NULL DEFAULT '{}',
    description      TEXT NOT NULL DEFAULT '',
    amenities        TEXT NOT NULL DEFAULT '[]',
    social_links     TEXT NOT NULL DEFAULT '[]',
    menu_url         TEXT NOT NULL DEFAULT '',
    booking_url      TEXT NOT NULL DEFAULT '',
    service_area     TEXT NOT NULL DEFAULT '',
    plus_code        TEXT NOT NULL DEFAULT '',
    details_scraped  INTEGER NOT NULL DEFAULT 0,
    reviews_scraped_at    TEXT NOT NULL DEFAULT '',
    review_scrape_status  TEXT NOT NULL DEFAULT '',
    website_emails        TEXT NOT NULL DEFAULT '[]',
    website_phones        TEXT NOT NULL DEFAULT '[]',
    website_contact_url   TEXT NOT NULL DEFAULT '',
    website_scraped_at    TEXT NOT NULL DEFAULT '',
    website_scrape_status TEXT NOT NULL DEFAULT '',
    scrape_method         TEXT NOT NULL DEFAULT 'fast',
    maps_thumbnail        TEXT NOT NULL DEFAULT '',
    website_og_image      TEXT NOT NULL DEFAULT '',
    maps_photos           TEXT NOT NULL DEFAULT '[]',
    photos_scraped_at     TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_zip   ON leads (zip)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone)`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    reviewer_name   TEXT NOT NULL DEFAULT '',
    reviewer_url    TEXT NOT NULL DEFAULT '',
    reviewer_rating INTEGER,
    review_date     TEXT NOT NULL DEFAULT '',
    review_text     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_lead_id ON reviews (lead_id)`,
  `CREATE TABLE IF NOT EXISTS outreach_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    zip        TEXT NOT NULL,
    phone      TEXT NOT NULL,
    lead_id    INTEGER NOT NULL REFERENCES leads(id),
    channel    TEXT NOT NULL CHECK (channel IN ('sms','email')),
    message    TEXT NOT NULL,
    opted_out  INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outreach_lead_id ON outreach_log (lead_id)`,
  `CREATE TABLE IF NOT EXISTS sms_queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    template   TEXT NOT NULL DEFAULT 'standard',
    message    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    sent_at    TEXT NOT NULL DEFAULT '',
    error      TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sms_queue_status  ON sms_queue (status)`,
  `CREATE INDEX IF NOT EXISTS idx_sms_queue_lead_id ON sms_queue (lead_id)`,
  `CREATE TABLE IF NOT EXISTS scraped_zips (
    zip         TEXT NOT NULL,
    category    TEXT NOT NULL,
    scraped_at  TEXT NOT NULL DEFAULT (datetime('now')),
    leads_found INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (zip, category)
  )`,
  // Live activity table — lets all computers see what others are doing
  `CREATE TABLE IF NOT EXISTS scrape_activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    host       TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'log',
    message    TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'main'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_created ON scrape_activity (created_at)`,

  // Job claiming table — prevents two computers scraping the same zip simultaneously
  `CREATE TABLE IF NOT EXISTS scrape_claims (
    zip        TEXT NOT NULL,
    category   TEXT NOT NULL,
    claimed_by TEXT NOT NULL DEFAULT '',
    claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (zip, category)
  )`,
  `INSERT OR REPLACE INTO _schema (key, value) VALUES ('version', '${CURRENT_VERSION}')`,
];

let _client: Client | null = null;

export function getDb(): Client {
  if (_client) return _client;
  fs.mkdirSync(DB_DIR, { recursive: true });
  const tursoUrl   = process.env['TURSO_DATABASE_URL'];
  const tursoToken = process.env['TURSO_AUTH_TOKEN'];
  if (tursoUrl && tursoToken) {
    _client = createClient({ url: tursoUrl, authToken: tursoToken });
    console.log('[db] Connected to Turso cloud');
  } else {
    _client = createClient({ url: `file:${LOCAL_DB}` });
    console.log('[db] Using local SQLite');
  }
  return _client;
}

export async function initDb(): Promise<void> {
  const db = getDb();
  // Check current version
  await db.execute(`CREATE TABLE IF NOT EXISTS _schema (key TEXT PRIMARY KEY, value TEXT)`);
  const r = await db.execute(`SELECT value FROM _schema WHERE key = 'version'`);
  const version = r.rows.length ? Number(r.rows[0]![0]) : 0;

  if (version >= CURRENT_VERSION) {
    console.log(`[db] schema up to date (v${version})`);
    return;
  }

  if (version === 0) {
    console.log(`[db] fresh install — running full schema...`);
    await db.batch(FULL_SCHEMA, 'write');
  } else {
    console.log(`[db] upgrading v${version} → v${CURRENT_VERSION}...`);
    // v10: add scrape_activity and scrape_claims tables
    if (version < 10) {
      await db.batch([
        `CREATE TABLE IF NOT EXISTS scrape_activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          host TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT 'log',
          message TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'main'
        )`,
        `CREATE INDEX IF NOT EXISTS idx_activity_created ON scrape_activity (created_at)`,
        `CREATE TABLE IF NOT EXISTS scrape_claims (
          zip TEXT NOT NULL,
          category TEXT NOT NULL,
          claimed_by TEXT NOT NULL DEFAULT '',
          claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (zip, category)
        )`,
        `INSERT OR REPLACE INTO _schema (key, value) VALUES ('version', '10')`,
      ], 'write');
    }
  }
  console.log('[db] migrations done');
}

export async function wipeAllData(): Promise<void> {
  const db = getDb();
  await db.batch([
    'DELETE FROM reviews',
    'DELETE FROM sms_queue',
    'DELETE FROM outreach_log',
    'DELETE FROM scraped_zips',
    'DELETE FROM leads',
  ], 'write');
}
