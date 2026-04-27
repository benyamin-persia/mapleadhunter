import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext } from 'playwright';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

chromium.use(StealthPlugin());

const contextOptions = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1280, height: 800 },
};

// Writable user-data directory — never inside Program Files
function userDataDir(subdir: string): string {
  if (process.env['GOOGLE_MAPS_PROFILE_DIR']) return process.env['GOOGLE_MAPS_PROFILE_DIR'];
  const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'MapLeadHunter', subdir);
}

// Track all active browsers so Stop can close them immediately
const _activeBrowsers = new Set<Browser | BrowserContext>();
export function closeAllBrowsers(): void {
  for (const b of _activeBrowsers) {
    b.close().catch(() => null);
  }
  _activeBrowsers.clear();
}

export async function launchStealthBrowser(): Promise<Browser> {
  logger.info('Launching Chromium (headless)');
  const browser = await chromium.launch({ headless: true }) as unknown as Browser;
  _activeBrowsers.add(browser);
  browser.on('disconnected', () => _activeBrowsers.delete(browser));
  return browser;
}

export async function newStealthContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext(contextOptions);
}

export async function openReviewContext(): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const profileDir = userDataDir('maps-profile');
  logger.info('Launching Chromium persistent context (headless)');
  const context = await chromium.launchPersistentContext(profileDir, {
    ...contextOptions,
    headless: true,
  }) as unknown as BrowserContext;
  _activeBrowsers.add(context);
  return {
    context,
    close: async () => { _activeBrowsers.delete(context); await context.close(); },
  };
}
