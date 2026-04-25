import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'leads.db');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;

  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(_db);
  return _db;
}

function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const version = row.user_version;

  if (version < 1) migrateTo1(db);
  if (version < 2) migrateTo2(db);
  if (version < 3) migrateTo3(db);
  if (version < 4) migrateTo4(db);
  if (version < 5) migrateTo5(db);
  if (version < 6) migrateTo6(db);
  if (version < 7) migrateTo7(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      reviewer_name TEXT    NOT NULL DEFAULT '',
      reviewer_url  TEXT    NOT NULL DEFAULT '',
      reviewer_rating INTEGER,
      review_date   TEXT    NOT NULL DEFAULT '',
      review_text   TEXT    NOT NULL DEFAULT '',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_lead_id ON reviews (lead_id);

    CREATE TABLE IF NOT EXISTS outreach_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      zip         TEXT    NOT NULL,
      phone       TEXT    NOT NULL,
      lead_id     INTEGER NOT NULL REFERENCES leads(id),
      channel     TEXT    NOT NULL CHECK (channel IN ('sms', 'email')),
      message     TEXT    NOT NULL,
      opted_out   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_lead_id ON outreach_log (lead_id);
  `);
}

function migrateTo1(db: DatabaseSync): void {
  // Recover from partial previous migration: if backup exists but leads doesn't, restore it
  const backupExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_leads_backup'").get();
  const leadsExists  = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'").get();

  if (backupExists && !leadsExists) {
    // Interrupted migration — restore backup as leads so data isn't lost
    db.exec('ALTER TABLE _leads_backup RENAME TO leads');
  } else if (backupExists && leadsExists) {
    // Both exist — previous migration completed but backup wasn't dropped
    db.exec('DROP TABLE _leads_backup');
  }

  const leadsNow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'").get();

  if (leadsNow) {
    // Split into individual statements — multi-statement exec can leave DB in
    // a partial state if it crashes, preventing user_version from being set
    db.exec('CREATE TABLE IF NOT EXISTS _leads_backup AS SELECT * FROM leads');
    db.exec('DROP TABLE leads');
    db.exec(`CREATE TABLE leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      zip         TEXT    NOT NULL DEFAULT '',
      phone       TEXT    NOT NULL DEFAULT '',
      name        TEXT    NOT NULL,
      address     TEXT    NOT NULL DEFAULT '',
      category    TEXT    NOT NULL DEFAULT '',
      rating      REAL,
      maps_url    TEXT    NOT NULL UNIQUE,
      website_url TEXT    NOT NULL DEFAULT '',
      has_website INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`INSERT OR IGNORE INTO leads
      (id, created_at, updated_at, zip, phone, name, address, category, rating, maps_url, website_url, has_website)
      SELECT id, created_at, updated_at, zip, phone, name, address, category, rating, maps_url, '', 0
      FROM _leads_backup`);
    db.exec('DROP TABLE IF EXISTS _leads_backup');
    db.exec('CREATE INDEX IF NOT EXISTS idx_leads_zip   ON leads (zip)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone)');
  } else {
    db.exec(`CREATE TABLE leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      zip         TEXT    NOT NULL DEFAULT '',
      phone       TEXT    NOT NULL DEFAULT '',
      name        TEXT    NOT NULL,
      address     TEXT    NOT NULL DEFAULT '',
      category    TEXT    NOT NULL DEFAULT '',
      rating      REAL,
      maps_url    TEXT    NOT NULL UNIQUE,
      website_url TEXT    NOT NULL DEFAULT '',
      has_website INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_leads_zip   ON leads (zip)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone)');
  }
  db.exec('PRAGMA user_version = 1');
}

function migrateTo3(db: DatabaseSync): void {
  const cols = (db.prepare('PRAGMA table_info(leads)').all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes('hours'))          db.exec("ALTER TABLE leads ADD COLUMN hours TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes('description'))    db.exec("ALTER TABLE leads ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('amenities'))      db.exec("ALTER TABLE leads ADD COLUMN amenities TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes('social_links'))   db.exec("ALTER TABLE leads ADD COLUMN social_links TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes('menu_url'))       db.exec("ALTER TABLE leads ADD COLUMN menu_url TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('booking_url'))    db.exec("ALTER TABLE leads ADD COLUMN booking_url TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('service_area'))   db.exec("ALTER TABLE leads ADD COLUMN service_area TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('plus_code'))      db.exec("ALTER TABLE leads ADD COLUMN plus_code TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('details_scraped')) db.exec('ALTER TABLE leads ADD COLUMN details_scraped INTEGER NOT NULL DEFAULT 0');
  db.exec('PRAGMA user_version = 3');
}

function migrateTo2(db: DatabaseSync): void {
  // Add review_count, price_level, open_now columns if not present
  const cols = (db.prepare("PRAGMA table_info(leads)").all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes('review_count')) db.exec('ALTER TABLE leads ADD COLUMN review_count INTEGER');
  if (!cols.includes('price_level'))  db.exec("ALTER TABLE leads ADD COLUMN price_level TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('open_now'))     db.exec("ALTER TABLE leads ADD COLUMN open_now TEXT NOT NULL DEFAULT ''");
  db.exec('PRAGMA user_version = 2');
}

function migrateTo4(db: DatabaseSync): void {
  const leadCols = (db.prepare('PRAGMA table_info(leads)').all() as { name: string }[]).map((r) => r.name);
  if (!leadCols.includes('reviews_scraped_at')) db.exec("ALTER TABLE leads ADD COLUMN reviews_scraped_at TEXT NOT NULL DEFAULT ''");
  if (!leadCols.includes('review_scrape_status')) db.exec("ALTER TABLE leads ADD COLUMN review_scrape_status TEXT NOT NULL DEFAULT ''");

  const reviewsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reviews'").get();
  if (reviewsTable) {
    const reviewCols = (db.prepare('PRAGMA table_info(reviews)').all() as { name: string }[]).map((r) => r.name);
    if (!reviewCols.includes('reviewer_url')) db.exec("ALTER TABLE reviews ADD COLUMN reviewer_url TEXT NOT NULL DEFAULT ''");
  }
  db.exec('PRAGMA user_version = 4');
}

function migrateTo5(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      template    TEXT    NOT NULL DEFAULT 'standard',
      message     TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
      sent_at     TEXT    NOT NULL DEFAULT '',
      error       TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sms_queue_status ON sms_queue (status);
    CREATE INDEX IF NOT EXISTS idx_sms_queue_lead_id ON sms_queue (lead_id);
  `);
  db.exec('PRAGMA user_version = 5');
}

function migrateTo6(db: DatabaseSync): void {
  const cols = (db.prepare('PRAGMA table_info(leads)').all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes('website_emails'))       db.exec("ALTER TABLE leads ADD COLUMN website_emails TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes('website_phones'))       db.exec("ALTER TABLE leads ADD COLUMN website_phones TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes('website_contact_url'))  db.exec("ALTER TABLE leads ADD COLUMN website_contact_url TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('website_scraped_at'))   db.exec("ALTER TABLE leads ADD COLUMN website_scraped_at TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('website_scrape_status'))db.exec("ALTER TABLE leads ADD COLUMN website_scrape_status TEXT NOT NULL DEFAULT ''");
  db.exec('PRAGMA user_version = 6');
}

function migrateTo7(db: DatabaseSync): void {
  const cols = (db.prepare('PRAGMA table_info(leads)').all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes('scrape_method')) db.exec("ALTER TABLE leads ADD COLUMN scrape_method TEXT NOT NULL DEFAULT 'fast'");
  db.exec('PRAGMA user_version = 7');
}
