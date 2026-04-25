import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

chromium.use(StealthPlugin());

const profileDir = path.resolve(process.env['GOOGLE_MAPS_PROFILE_DIR'] ?? 'data/maps-profile');
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1280, height: 800 },
});

const page = await context.newPage();
await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 60_000 });

console.log(`Maps profile opened at: ${profileDir}`);
console.log('Sign in to Google Maps in the opened browser. When Maps shows full access, return here and press Enter.');

const rl = readline.createInterface({ input, output });
await rl.question('');
rl.close();
await context.close();
