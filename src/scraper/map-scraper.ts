import type { BrowserContext, Page } from 'playwright';
import { launchStealthBrowser, newStealthContext } from '../utils/stealth.js';
import { randomDelay } from '../utils/delays.js';
import { extractAllCards } from './extractors.js';
import { logger } from '../utils/logger.js';
import type { NewLead } from '../leads/repository.js';

export type ProgressEvent = { type: 'log' | 'lead' | 'error' | 'done' | 'start'; message: string };
export type ProgressCallback = (event: ProgressEvent) => void;

export type FullDetail = {
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
};

export type ScrapeResult = { leads: NewLead[]; detailsMap: Map<string, FullDetail> };

const DEFAULT_MAX = Number(process.env['SCRAPE_MAX_PER_ZIP'] ?? 500);

const US_STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

function addressMatchesState(address: string, stateAbbr: string): boolean {
  if (!address || !stateAbbr) return true; // no address — keep it, detail page will fix
  const m = address.match(US_STATES);
  if (!m) return true; // no state found in address — keep it
  return m[1]?.toUpperCase() === stateAbbr.toUpperCase(); // only reject if clearly wrong state
}

export async function scrapeZip(
  zip: string,
  category: string,
  maxPerZip = DEFAULT_MAX,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  expectedState?: string,
  detailFirst = false,
): Promise<ScrapeResult> {
  const emit = (type: ProgressEvent['type'], message: string) => {
    logger.info(message);
    onProgress?.({ type, message });
  };

  const browser = await launchStealthBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();
  const abort = () => {
    void context.close().catch(() => null);
    void browser.close().catch(() => null);
  };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    return await runScrape(page, zip, category, maxPerZip, emit, signal, expectedState, detailFirst);
  } finally {
    signal?.removeEventListener('abort', abort);
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function runScrape(
  page: Page,
  zip: string,
  category: string,
  maxPerZip: number,
  emit: (type: ProgressEvent['type'], message: string) => void,
  signal?: AbortSignal,
  expectedState?: string,
  detailFirst = false,
): Promise<ScrapeResult> {
  if (signal?.aborted) return { leads: [], detailsMap: new Map() };
  await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (signal?.aborted) return { leads: [], detailsMap: new Map() };
  await page.waitForSelector('input[name="q"]', { timeout: 15_000 });

  await page.fill('input[name="q"]', `${category} near ${zip}`);
  await page.keyboard.press('Enter');

  await page.waitForTimeout(5000);
  if (signal?.aborted) return { leads: [], detailsMap: new Map() };
  await page.waitForSelector('div[role="feed"]', { timeout: 20_000 });

  if (await isBlocked(page)) {
    emit('error', `BLOCKED on ${zip} — switch proxy or wait`);
    return { leads: [], detailsMap: new Map() };
  }

  await scrollFeedToEnd(page, maxPerZip, signal);
  if (signal?.aborted) return { leads: [], detailsMap: new Map() };
  await randomDelay(1000, 2000);

  const allCards = await extractAllCards(page);

  const cards = expectedState
    ? allCards.filter((c) => addressMatchesState(c.address, expectedState))
    : allCards;

  const filtered = allCards.length - cards.length;
  if (filtered > 0) emit('log', `⚠ Skipped ${filtered} off-location result(s) (Google serving national results — slow down or use a proxy)`);

  const withSite = cards.filter((c) => c.hasWebsite).length;
  const withoutSite = cards.filter((c) => !c.hasWebsite).length;
  emit('log', `Found ${cards.length} listings in ${zip} (${withSite} with website, ${withoutSite} without)`);

  const leads: NewLead[] = [];
  const detailsMap = new Map<string, FullDetail>();

  for (const card of cards) {
    if (leads.length >= maxPerZip) break;
    if (signal?.aborted) break;

    // Visit detail page if: detailFirst mode, OR missing phone/address, OR
    // has website chip but no actual URL (Google renders chip as redirect, not real href)
    const needsDetail = detailFirst || !card.phone || !card.address ||
      (card.hasWebsite && !card.websiteUrl);
    let phone = card.phone;
    let address = card.address;
    let websiteUrl = card.websiteUrl;
    let hasWebsite = card.hasWebsite;

    if (needsDetail) {
      const detail = await extractDetailsFromPage(page.context(), card.mapsUrl, signal, detailFirst);
      phone = detail.phone || card.phone;
      address = detail.address || card.address;
      websiteUrl = detail.websiteUrl || card.websiteUrl;
      hasWebsite = detail.hasWebsite || card.hasWebsite;
      if (detailFirst) detailsMap.set(card.mapsUrl, detail);
    }

    leads.push({
      zip,
      phone,
      name: card.name,
      address,
      category: card.category || category,
      rating: card.rating,
      reviewCount: card.reviewCount,
      priceLevel: card.priceLevel,
      openNow: card.openNow,
      maps_url: card.mapsUrl,
      website_url: websiteUrl,
      has_website: hasWebsite,
      scrape_method: detailFirst ? 'detail' : 'fast',
      maps_thumbnail: card.thumbnail,
    });

    const badge = hasWebsite ? '🌐' : '📵';
    const siteFound = !card.hasWebsite && hasWebsite ? ' ✨website found on detail' : '';
    const phoneTag = phone ? ` | ☎ ${phone}` : ' | no phone';
    const addrTag = address ? ` | 📍 ${address}` : '';
    const ratingTag = card.rating ? ` | ⭐ ${card.rating}` : '';
    emit('lead', `${badge} ${card.name}${phoneTag}${addrTag}${ratingTag}${siteFound}`);
  }

  emit('log', `Done with ${zip}: ${leads.length} business(es) captured`);
  return { leads, detailsMap };
}

async function scrollFeedToEnd(page: Page, maxResults: number, signal?: AbortSignal): Promise<void> {
  const feed = page.locator('div[role="feed"]');
  let previousHeight = 0;
  let sameCount = 0;

  while (sameCount <= 2) {
    if (signal?.aborted) break;
    const currentHeight = await feed.evaluate((el) => {
      el.scrollTo(0, el.scrollHeight);
      return el.scrollHeight;
    });

    const cardCount = await page.$$eval('div[role="article"]', (els) => els.length);
    if (cardCount >= maxResults * 2) break;

    if (currentHeight === previousHeight) sameCount++;
    else { sameCount = 0; previousHeight = currentHeight; }
    await page.waitForTimeout(1200).catch(() => null);
  }
}

async function isBlocked(page: Page): Promise<boolean> {
  const url = page.url();
  const title = await page.title();
  return (
    url.includes('sorry') ||
    title.toLowerCase().includes('captcha') ||
    title.toLowerCase().includes('unusual traffic')
  );
}

async function extractDetailsFromPage(
  context: BrowserContext,
  mapsUrl: string,
  signal?: AbortSignal,
  full = false,
): Promise<FullDetail> {
  const empty: FullDetail = { phone: '', address: '', websiteUrl: '', hasWebsite: false, hours: {}, description: '', amenities: [], socialLinks: [], menuUrl: '', bookingUrl: '', serviceArea: '', plusCode: '' };
  if (!mapsUrl || signal?.aborted) return empty;

  let page: Awaited<ReturnType<typeof context.newPage>> | undefined;
  try {
    page = await context.newPage();
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForSelector('[data-item-id]', { timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(800);
    if (signal?.aborted) return empty;

    // Step 1: extract contact + website BEFORE clicking hours toggle
    // Pass `full` as argument — page.evaluate cannot access outer Node.js scope
    const contact = await page.evaluate((isFull: boolean) => {
      const rawPhone =
        document.querySelector('button[data-item-id^="phone"]')?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ||
        document.querySelector('[aria-label^="Phone:"]')?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ||
        (document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null)?.href?.replace(/^tel:/i, '').trim() ||
        '';
      const phone = rawPhone.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? rawPhone;

      const address =
        document.querySelector('button[data-item-id="address"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ||
        document.querySelector('[aria-label^="Address:"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '').trim() ||
        document.querySelector('button[data-item-id="address"]')?.textContent?.trim() ||
        document.querySelector('[aria-label*="Serves"]')?.textContent?.trim() ||
        document.querySelector('[data-item-id*="service"]')?.getAttribute('aria-label')?.trim() ||
        '';

      // JSON-LD is the most reliable website URL source — try it first
      let websiteUrl = '';
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        if (websiteUrl) return;
        try {
          const d = JSON.parse(s.textContent ?? '') as Record<string, unknown>;
          const u = (d['url'] ?? (d['@graph'] as Record<string, unknown>[])?.[0]?.['url']) as string | undefined;
          if (u && typeof u === 'string' && !u.includes('google.com')) websiteUrl = u;
        } catch { /* skip */ }
      });

      // Fall back to DOM anchor selectors
      const websiteAnchor = (
        document.querySelector('a[data-item-id="authority"]') ??
        document.querySelector('a[aria-label^="Website"]') ??
        document.querySelector('a[data-tooltip="Open website"]')
      ) as HTMLAnchorElement | null;
      const hasWebsite = !!websiteAnchor || websiteUrl.length > 0;

      if (!websiteUrl && websiteAnchor) {
        const labelUrl = (websiteAnchor.getAttribute('aria-label') ?? '').replace(/^Website:\s*/i, '').trim();
        const rawHref = websiteAnchor.href ?? '';
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
        if (!websiteUrl) websiteUrl = websiteAnchor.textContent?.trim() ?? '';
      }

      if (websiteUrl && !websiteUrl.startsWith('http')) websiteUrl = 'https://' + websiteUrl;
      if (!isFull) return { phone, address, websiteUrl, hasWebsite, description: '', amenities: [] as string[], socialLinks: [] as { platform: string; url: string }[], menuUrl: '', bookingUrl: '', serviceArea: '', plusCode: '' };

      const description =
        document.querySelector('div.PYvSYb')?.textContent?.trim() ??
        document.querySelector('div[data-attrid="description"] div')?.textContent?.trim() ??
        '';

      const amenities: string[] = [];
      document.querySelectorAll('div.LTs0Oc li, div.E0DTEd li, span.hpLkke').forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length < 80) amenities.push(text);
      });

      const socialPatterns = [
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

      const menuAnchor = document.querySelector('a[data-item-id="menu"], a[aria-label*="Menu"], a[href*="menu"]') as HTMLAnchorElement | null;
      const menuUrl = menuAnchor?.href ?? '';
      const bookAnchor = document.querySelector('a[data-item-id*="book"], a[aria-label*="Book"], a[aria-label*="Reserve"], a[aria-label*="Appointment"]') as HTMLAnchorElement | null;
      const bookingUrl = bookAnchor?.href ?? '';
      const serviceArea = document.querySelector('[aria-label*="Serves"]')?.textContent?.trim() ?? '';
      const plusCode =
        document.querySelector('button[data-item-id="oloc"]')?.getAttribute('aria-label')?.replace(/^Plus code:\s*/i, '').trim() ??
        document.querySelector('[aria-label*="plus code"]')?.getAttribute('aria-label')?.replace(/^Plus code:\s*/i, '').trim() ??
        '';

      return { phone, address, websiteUrl, hasWebsite, description, amenities, socialLinks, menuUrl, bookingUrl, serviceArea, plusCode };
    }, full);

    // Step 2: expand hours then extract (only for full detail mode)
    let hours: Record<string, string> = {};
    if (full) {
      const hoursToggle = page.locator('button[data-item-id*="oh"]').first();
      if (await hoursToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
        await hoursToggle.click().catch(() => null);
        await page.waitForTimeout(800);
      }
      hours = await page.evaluate((): Record<string, string> => {
        const result: Record<string, string> = {};
        document.querySelectorAll('table.eK4R0e tr').forEach((row) => {
          const cells = row.querySelectorAll('td');
          const day = cells[0]?.textContent?.trim() ?? '';
          const time = cells[1]?.textContent?.trim() ?? '';
          if (day) result[day] = time || 'Closed';
        });
        if (Object.keys(result).length === 0) {
          const ariaHours = document.querySelector('[aria-label*="Monday"],[aria-label*="Sunday"]')?.getAttribute('aria-label') ?? '';
          ariaHours.split(';').forEach((part) => {
            const m = part.trim().match(/^(\w+day),\s*(.+)$/);
            if (m) result[m[1] ?? ''] = m[2] ?? '';
          });
        }
        return result;
      });
    }

    return { ...contact, hours };
  } catch {
    return empty;
  } finally {
    await page?.close().catch(() => null);
  }
}
