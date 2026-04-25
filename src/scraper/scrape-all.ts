import { launchStealthBrowser, newStealthContext } from '../utils/stealth.js';
import { randomDelay } from '../utils/delays.js';
import { logger } from '../utils/logger.js';
import { extractReviews } from './review-scraper.js';
import type { BusinessDetails } from './detail-scraper.js';
import type { Review } from './review-scraper.js';

export interface ScrapeAllResult {
  details: BusinessDetails;
  reviews: Review[];
}

export async function scrapeAll(mapsUrl: string, maxReviews = 50): Promise<ScrapeAllResult> {
  const browser = await launchStealthBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  const empty: BusinessDetails = {
    phone: '', address: '', websiteUrl: '', hasWebsite: false,
    hours: {}, description: '', amenities: [], socialLinks: [],
    menuUrl: '', bookingUrl: '', serviceArea: '', plusCode: '',
  };

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await randomDelay(3000, 4000);

    // ── Expand hours if collapsed ─────────────────────────────────────────
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const hoursBtn = buttons.find((b) =>
        b.getAttribute('data-item-id')?.includes('oh') ||
        /hours/i.test(b.getAttribute('aria-label') ?? ''),
      );
      if (hoursBtn) (hoursBtn as HTMLElement).click();
    }).catch(() => null);
    await randomDelay(600, 1000);

    // ── Extract all details from current page ─────────────────────────────
    const details = await page.evaluate((): BusinessDetails => {
      const normalizePhone = (value: string | null | undefined): string => {
        const text = (value ?? '')
          .replace(/^Phone:\s*/i, '')
          .replace(/^tel:/i, '')
          .trim();
        return text.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? text;
      };

      const phoneButton = document.querySelector('button[data-item-id^="phone"]') as HTMLElement | null;
      const phone =
        normalizePhone(phoneButton?.querySelector('.Io6YTe')?.textContent) ||
        normalizePhone(phoneButton?.getAttribute('aria-label')) ||
        normalizePhone(document.querySelector('[aria-label^="Phone:"]')?.getAttribute('aria-label')) ||
        normalizePhone((document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null)?.href);

      const hours: Record<string, string> = {};
      document.querySelectorAll('table.eK4R0e tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        const day  = cells[0]?.textContent?.trim() ?? '';
        const time = cells[1]?.textContent?.trim() ?? '';
        if (day) hours[day] = time || 'Closed';
      });
      if (Object.keys(hours).length === 0) {
        const ariaHours = document.querySelector('[aria-label*="Monday"],[aria-label*="Sunday"]')
          ?.getAttribute('aria-label') ?? '';
        ariaHours.split(';').forEach((part) => {
          const m = part.trim().match(/^(\w+day),\s*(.+)$/);
          if (m) hours[m[1] ?? ''] = m[2] ?? '';
        });
      }

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

      const menuAnchor = document.querySelector('a[data-item-id="menu"], a[aria-label*="Menu"]') as HTMLAnchorElement | null;
      const bookAnchor = document.querySelector('a[data-item-id*="book"], a[aria-label*="Book"], a[aria-label*="Reserve"]') as HTMLAnchorElement | null;
      const serviceArea = document.querySelector('button[data-item-id*="ltr"] .Io6YTe')?.textContent?.trim() ?? '';
      const plusCode = document.querySelector('button[data-item-id*="oloc"] .Io6YTe')?.textContent?.trim() ?? '';
      const address =
        document.querySelector('button[data-item-id="address"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ||
        document.querySelector('[aria-label^="Address:"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ||
        document.querySelector('button[data-item-id="address"]')?.textContent?.trim() ||
        '';
      const websiteAnchor = document.querySelector('a[data-item-id="authority"], a[data-value="Website"], a[aria-label*="website" i]') as HTMLAnchorElement | null;
      const websiteUrl = websiteAnchor?.href ?? '';

      return {
        phone, address, websiteUrl, hasWebsite: websiteUrl.length > 0,
        hours, description, amenities, socialLinks,
        menuUrl: menuAnchor?.href ?? '',
        bookingUrl: bookAnchor?.href ?? '',
        serviceArea,
        plusCode,
      };
    });

    logger.info({ url: mapsUrl }, 'details extracted, switching to reviews tab');

    // ── Now extract reviews in the same browser session ───────────────────
    const reviews = await extractReviews(page, maxReviews);

    return { details, reviews };
  } catch (err) {
    logger.error({ err }, 'scrape-all failed');
    return { details: empty, reviews: [] };
  } finally {
    await context.close();
    await browser.close();
  }
}
