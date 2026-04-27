/**
 * One-time migration: reads the old leads.db (node:sqlite) and imports all
 * data into the new libsql/Turso database.
 *
 * Run once with:  node scripts/migrate-legacy-db.mjs
 */

import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dirname, '../data');
const LEGACY    = path.join(DATA_DIR, 'leads.db');

if (!fs.existsSync(LEGACY)) {
  console.log('No legacy leads.db found — nothing to migrate.');
  process.exit(0);
}

const tursoUrl   = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;

// Connect directly to Turso (no local replica file — avoids file lock conflict)
const newClient = tursoUrl && tursoToken
  ? createClient({ url: tursoUrl, authToken: tursoToken })
  : createClient({ url: `file:${path.join(DATA_DIR, 'leads-sync.db')}` });

const old = new DatabaseSync(LEGACY);

const tables = ['leads', 'reviews', 'outreach_log', 'sms_queue', 'scraped_zips'];

for (const table of tables) {
  const exists = old.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  if (!exists) { console.log(`  skip ${table} (not in legacy DB)`); continue; }

  const rows = old.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) { console.log(`  ${table}: 0 rows (empty)`); continue; }

  // Get columns that exist in BOTH old and new DB to avoid schema mismatch
  const oldCols = Object.keys(rows[0]);
  let newCols;
  try {
    const r = await newClient.execute(`PRAGMA table_info(${table})`);
    newCols = new Set(r.rows.map(row => String(row[1])));
  } catch (e) {
    console.error(`  ${table}: could not read new schema —`, e.message);
    continue;
  }

  const cols = oldCols.filter(c => newCols.has(c));
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;

  let inserted = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      await newClient.execute({ sql, args: cols.map(c => row[c] ?? null) });
      inserted++;
    } catch (e) {
      if (errors < 3) console.error(`  ${table} row error:`, e.message);
      errors++;
    }
  }
  console.log(`  ${table}: ${inserted}/${rows.length} migrated${errors ? ` (${errors} errors)` : ''}`);
}

old.close();
console.log('\nDone. Run "npm run web" to start the app with your migrated data.');
