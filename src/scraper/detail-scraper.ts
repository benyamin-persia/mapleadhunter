import { launchStealthBrowser, newStealthContext } from '../utils/stealth.js';
import { randomDelay } from '../utils/delays.js';
import { logger } from '../utils/logger.js';

export interface BusinessDetails {
  phone: string;
  address: string;
  websiteUrl: string;
  hasWebsite: boolean;
  hours: Record<string, string>;
  description: string;
  amenities: string[];
  socialLinks: { platform: string; url: string }[];
  menuUrl: string;
  bookingUrl: string;
  serviceArea: string;
  plusCode: string;
}

export async function scrapeDetails(mapsUrl: string): Promise<BusinessDetails> {
  const browser = await launchStealthBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  try {
    // Warm up Maps session before navigating to the business URL
    await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await randomDelay(1500, 2500);

    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait up to 20s for panel action buttons (phone, address) — they load lazily
    await page.waitForSelector('[data-item-id]', { timeout: 20_000 }).catch(() => null);
    await randomDelay(800, 1200);

    // ── Step 1: Extract contact info BEFORE clicking any buttons ──────────
    const contact = await page.evaluate(() => {
      const rawPhone =
        document.querySelector('button[data-item-id^="phone"]')?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ||
        document.querySelector('[aria-label^="Phone:"]')?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ||
        (document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null)?.href?.replace(/^tel:/i, '').trim() ||
        document.querySelector('button[data-item-id^="phone"]')?.textContent?.trim() ||
        '';
      const phone = rawPhone.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? rawPhone;

      const address =
        document.querySelector('button[data-item-id="address"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ||
        document.querySelector('[aria-label^="Address:"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ||
        document.querySelector('button[data-item-id="address"]')?.textContent?.trim() ||
        document.querySelector('[aria-label*="Serves"]')?.textContent?.trim() ||
        document.querySelector('[data-item-id*="service"]')?.getAttribute('aria-label')?.trim() ||
        '';

      const description =
        document.querySelector('div.PYvSYb')?.textContent?.trim() ??
        document.querySelector('div[data-attrid="description"] div')?.textContent?.trim() ??
        document.querySelector('div.iP2t7d')?.textContent?.trim() ??
        '';

      const amenities: string[] = [];
      document.querySelectorAll('div.LTs0Oc li, div.E0DTEd li, span.hpLkke').forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length < 80) amenities.push(text);
      });

      const socialPatterns: { pattern: string; platform: string }[] = [
        { pattern: 'facebook.com', platform: 'Facebook' },
        { pattern: 'instagram.com', platform: 'Instagram' },
        { pattern: 'twitter.com', platform: 'Twitter' },
        { pattern: 'x.com', platform: 'Twitter' },
        { pattern: 'linkedin.com', platform: 'LinkedIn' },
        { pattern: 'youtube.com', platform: 'YouTube' },
        { pattern: 'tiktok.com', platform: 'TikTok' },
        { pattern: 'yelp.com', platform: 'Yelp' },
      ];
      const socialLinks: { platform: string; url: string }[] = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        for (const sp of socialPatterns) {
          if (href.includes(sp.pattern) && !socialLinks.find((s) => s.platform === sp.platform)) {
            socialLinks.push({ platform: sp.platform, url: href });
            break;
          }
        }
      });

      const menuAnchor = document.querySelector(
        'a[data-item-id="menu"], a[aria-label*="Menu"], a[href*="menu"]',
      ) as HTMLAnchorElement | null;
      const menuUrl = menuAnchor?.href ?? '';

      const bookAnchor = document.querySelector(
        'a[data-item-id*="book"], a[aria-label*="Book"], a[aria-label*="Reserve"], a[aria-label*="Appointment"]',
      ) as HTMLAnchorElement | null;
      const bookingUrl = bookAnchor?.href ?? '';

      const serviceArea = document.querySelector('[aria-label*="Serves"]')?.textContent?.trim() ?? '';

      const plusCode =
        document.querySelector('button[data-item-id="oloc"]')?.getAttribute('aria-label')?.replace(/^Plus code:\s*/i, '').trim() ??
        document.querySelector('[aria-label*="plus code"]')?.getAttribute('aria-label')?.replace(/^Plus code:\s*/i, '').trim() ??
        '';

      // JSON-LD structured data is the most reliable source for website URL
      let websiteUrl = '';
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        if (websiteUrl) return;
        try {
          const d = JSON.parse(s.textContent ?? '') as Record<string, unknown>;
          const u = (d['url'] ?? (d['@graph'] as Record<string, unknown>[])?.[0]?.['url']) as string | undefined;
          if (u && typeof u === 'string' && !u.includes('google.com')) websiteUrl = u;
        } catch { /* skip */ }
      });

      const websiteAnchor = (
        document.querySelector('a[data-item-id="authority"]') ??
        document.querySelector('a[aria-label^="Website"]') ??
        document.querySelector('a[data-tooltip="Open website"]')
      ) as HTMLAnchorElement | null;
      const hasWebsite = !!websiteAnchor || websiteUrl.length > 0;

      if (!websiteUrl && websiteAnchor) {
        const labelUrl = (websiteAnchor.getAttribute('aria-label') ?? '').replace(/^Website:\s*/i, '').trim();
        const rawHref = websiteAnchor.href ?? '';
        const textUrl = websiteAnchor.textContent?.trim() ?? '';
        if (labelUrl.includes('.')) {
          websiteUrl = labelUrl;
        } else {
          try {
            if (rawHref.includes('google.com') && rawHref.includes('?')) {
              const u = new URL(rawHref);
              websiteUrl = u.searchParams.get('q') ?? u.searchParams.get('url') ?? rawHref;
            } else {
              websiteUrl = rawHref;
            }
          } catch { websiteUrl = rawHref; }
        }
        if (!websiteUrl && textUrl.includes('.')) websiteUrl = textUrl;
      }

      // Ensure URL has protocol prefix
      if (websiteUrl && !websiteUrl.startsWith('http')) websiteUrl = 'https://' + websiteUrl;
      return { phone, address, websiteUrl, hasWebsite, description, amenities, socialLinks, menuUrl, bookingUrl, serviceArea, plusCode };
    });

    // ── Step 2: Expand hours then extract separately ───────────────────────
    const hoursToggle = page.locator('button[data-item-id*="oh"]').first();
    if (await hoursToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      await hoursToggle.click().catch(() => null);
      await randomDelay(600, 1000);
    }

    const hours = await page.evaluate((): Record<string, string> => {
      const result: Record<string, string> = {};
      document.querySelectorAll('table.eK4R0e tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        const day  = cells[0]?.textContent?.trim() ?? '';
        const time = cells[1]?.textContent?.trim() ?? '';
        if (day) result[day] = time || 'Closed';
      });
      if (Object.keys(result).length === 0) {
        const ariaHours = document.querySelector('[aria-label*="Monday"],[aria-label*="Sunday"]')
          ?.getAttribute('aria-label') ?? '';
        ariaHours.split(';').forEach((part) => {
          const m = part.trim().match(/^(\w+day),\s*(.+)$/);
          if (m) result[m[1] ?? ''] = m[2] ?? '';
        });
      }
      return result;
    });

    const details: BusinessDetails = { ...contact, hours };
    logger.info({ url: mapsUrl, phone: details.phone, address: details.address, hours: Object.keys(hours).length }, 'details scraped');
    return details;
  } catch (err) {
    logger.error({ err }, 'detail scrape failed');
    return { phone: '', address: '', websiteUrl: '', hasWebsite: false, hours: {}, description: '', amenities: [], socialLinks: [], menuUrl: '', bookingUrl: '', serviceArea: '', plusCode: '' };
  } finally {
    await context.close();
    await browser.close();
  }
}
