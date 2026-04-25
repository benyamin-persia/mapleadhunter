/**
 * Run once: node scripts/setup-geo.mjs
 * Downloads US zip code data and saves to data/geo.json
 */
import { writeFileSync, mkdirSync } from 'fs';

const CSV_URL = 'https://raw.githubusercontent.com/scpike/us-state-county-zip/master/geo-data.csv';
const OUT = './data/geo.json';

function parseLine(line) {
  // Handles quoted fields (e.g. "St. Louis, City")
  const fields = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur);
  return fields;
}

console.log('Downloading geo data from GitHub...');
const res = await fetch(CSV_URL);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const text = await res.text();
const lines = text.trim().split('\n');

const stateNames = {};
// byState[abbr][county] = [{city, zip}]
const byState = {};

let count = 0;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i]?.trim();
  if (!line) continue;
  const parts = parseLine(line);
  // columns: state_fips, state, state_abbr, zipcode, county, city
  const state    = parts[1]?.trim() ?? '';
  const abbr     = parts[2]?.trim() ?? '';
  const zip      = parts[3]?.trim() ?? '';
  const county   = parts[4]?.trim() ?? '';
  const city     = parts[5]?.trim() ?? '';

  if (!abbr || !/^\d{3,5}$/.test(zip)) continue;

  // Pad zip to 5 digits (leading zeros for NE states)
  const zip5 = zip.padStart(5, '0');

  if (!stateNames[abbr]) stateNames[abbr] = state;
  if (!byState[abbr]) byState[abbr] = {};
  if (!byState[abbr][county]) byState[abbr][county] = [];
  byState[abbr][county].push({ city, zip: zip5 });
  count++;
}

const states = Object.entries(stateNames)
  .map(([abbr, name]) => ({ abbr, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync('./data', { recursive: true });
writeFileSync(OUT, JSON.stringify({ states, byState }));
console.log(`✅ Saved ${count} zip codes across ${states.length} states → ${OUT}`);
