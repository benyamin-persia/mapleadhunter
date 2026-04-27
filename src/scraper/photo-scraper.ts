import { launchStealthBrowser, newStealthContext } from '../utils/stealth.js';
import { randomDelay } from '../utils/delays.js';
import { logger } from '../utils/logger.js';

const PHOTO_URL_RX = /https:\/\/lh[0-9]\.googleusercontent\.com\/p\/[^"'\s]+/g;

function upgradeResolution(url: string): string {
  return url.replace(/=w\d+-h\d+[^"'\s]*/g, '=w800-h600-k-no');
}

export async function scrapeMapPhotos(mapsUrl: string, max = 20): Promise<string[]> {
  logger.info({ url: mapsUrl }, 'Launching Chromium for photo scrape (headless)');
  const browser = await launchStealthBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await randomDelay(2500, 3500);

    // Click the Photos tab if present
    const photoTab = page.getByRole('tab', { name: /photos?/i }).first();
    if (await photoTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await photoTab.click().catch(() => null);
      await randomDelay(1500, 2500);
    } else {
      // Try clicking a "See photos" / "View photos" button
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const photoBtn = btns.find((el) => /see\s*(all\s*)?photos?|view\s*photos?/i.test(el.textContent ?? ''));
        if (photoBtn) (photoBtn as HTMLElement).click();
      }).catch(() => null);
      await randomDelay(1500, 2000);
    }

    // Scroll the photo panel to load more images
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => null);
      await randomDelay(600, 900);
    }

    // Extract from DOM img tags first
    const domPhotos = await page.evaluate((maxPhotos: number): string[] => {
      const seen = new Set<string>();
      const results: string[] = [];
      document.querySelectorAll('img[src*="googleusercontent.com/p/"]').forEach((img) => {
        const src = (img as HTMLImageElement).src;
        if (src && !seen.has(src)) { seen.add(src); results.push(src); }
      });
      // Also check srcset
      document.querySelectorAll('img[srcset*="googleusercontent.com/p/"]').forEach((img) => {
        const srcset = (img as HTMLImageElement).srcset ?? '';
        srcset.split(',').forEach((part) => {
          const url = part.trim().split(' ')[0] ?? '';
          if (url.includes('googleusercontent.com/p/') && !seen.has(url)) { seen.add(url); results.push(url); }
        });
      });
      return results.slice(0, maxPhotos);
    }, max);

    // Fall back to regex scan of full HTML if DOM extraction found few results
    let photos = domPhotos;
    if (photos.length < 3) {
      const html = await page.content().catch(() => '');
      const matches = [...html.matchAll(PHOTO_URL_RX)].map((m) => m[0]);
      const seen = new Set(photos);
      for (const url of matches) {
        if (!seen.has(url)) { seen.add(url); photos.push(url); }
        if (photos.length >= max) break;
      }
    }

    const result = photos.map(upgradeResolution).slice(0, max);
    logger.info({ url: mapsUrl, count: result.length }, 'photos scraped');
    return result;
  } catch (err) {
    logger.error({ err, url: mapsUrl }, 'photo scrape failed');
    return [];
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}
