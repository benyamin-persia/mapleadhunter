import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext } from 'playwright';
import path from 'path';

chromium.use(StealthPlugin());

const contextOptions = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1280, height: 800 },
};

export async function launchStealthBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true }) as unknown as Browser;
}

export async function newStealthContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext(contextOptions);
}

export async function openReviewContext(): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const profileDir = process.env['GOOGLE_MAPS_PROFILE_DIR'] ?? 'data/maps-profile';
  const context = await chromium.launchPersistentContext(path.resolve(profileDir), {
    ...contextOptions,
    headless: process.env['REVIEW_HEADLESS'] === 'true',
  }) as unknown as BrowserContext;
  return { context, close: () => context.close() };
}
