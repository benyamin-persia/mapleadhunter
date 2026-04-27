import type { Page } from 'playwright';

export interface BusinessCard {
  name: string;
  phone: string;
  address: string;
  category: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string;
  openNow: string;
  mapsUrl: string;
  websiteUrl: string;
  hasWebsite: boolean;
  thumbnail: string;
}

/**
 * Extract all business cards directly from the feed — no per-page visits needed.
 * Phone, website chip, and website URL are present in the feed HTML itself.
 */
export async function extractAllCards(page: Page): Promise<BusinessCard[]> {
  return page.$$eval('div[role="article"]', (articles) => {
    return articles.map((el) => {
      const name = el.querySelector('div.qBF1Pd')?.textContent?.trim() ?? '';
      const anchor = el.querySelector('a.hfpxzc') as HTMLAnchorElement | null;
      const mapsUrl = anchor?.href ?? '';

      const phone = el.querySelector('span.UsdlK')?.textContent?.trim() ?? '';

      const websiteAnchor = (
        el.querySelector('a[data-value="Website"]') ??
        el.querySelector('a[aria-label*="website" i]') ??
        el.querySelector('a[jslog*="website"]') ??
        el.querySelector('a[href]:not([href*="google.com/maps"]):not([href*="google.com/search"]):not(.hfpxzc)')
      ) as HTMLAnchorElement | null;
      const hasWebsite = websiteAnchor !== null;
      const rawHref = websiteAnchor?.href ?? '';
      // Strip Google redirect wrappers — real URL is in ?q= or ?url= param
      let websiteUrl = rawHref;
      try {
        if (rawHref.includes('google.com') && rawHref.includes('?')) {
          const u = new URL(rawHref);
          websiteUrl = u.searchParams.get('q') ?? u.searchParams.get('url') ?? rawHref;
        }
      } catch { /* keep rawHref */ }

      const ratingText = el.querySelector('span.MW4etd')?.textContent?.trim();
      const rating = ratingText ? parseFloat(ratingText) : null;

      // Review count e.g. "(1,234)" → 1234
      const reviewText = el.querySelector('span.UY7F9')?.textContent?.trim() ?? '';
      const reviewMatch = reviewText.replace(/,/g, '').match(/\d+/);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[0] ?? '0', 10) : null;

      const rows = Array.from(el.querySelectorAll('div.W4Efsd > div.W4Efsd'));
      const firstRow = rows[0]?.textContent?.trim() ?? '';
      const parts = firstRow.split('·').map((s) => s.trim());
      const category = parts[0] ?? '';
      const address = parts[1] ?? '';

      // Price level e.g. "$", "$$", "$$$" — look in all row text
      const allRowText = rows.map((r) => r.textContent?.trim() ?? '').join(' ');
      const priceMatch = allRowText.match(/^\$+$/m) ?? allRowText.match(/·\s*(\$+)\s*·/);
      const priceLevel = priceMatch ? (priceMatch[1] ?? priceMatch[0] ?? '').trim() : '';

      // Open/Closed status
      const openEl = el.querySelector('span.ePhySb, span[class*="open"], span[class*="Open"]');
      const openNow = openEl?.textContent?.trim() ?? '';

      const thumbImg = el.querySelector('img[src*="googleusercontent"]') as HTMLImageElement | null;
      const thumbnail = thumbImg?.src
        ? thumbImg.src.replace(/=w\d+-h\d+/, '=w400-h300')
        : '';

      return { name, phone, address, category, rating, reviewCount, priceLevel, openNow, mapsUrl, websiteUrl, hasWebsite, thumbnail };
    }).filter((b) => b.name.length > 0);
  });
}

// ── Test helpers (mocked page) ─────────────────────────────────────────────

export interface BusinessDetail {
  name: string;
  address: string;
  phone: string;
  category: string;
  rating: number | null;
  mapsUrl: string;
  websiteUrl: string;
  hasWebsite: boolean;
}

async function getText(page: Page, selector: string): Promise<string> {
  try {
    return (await page.$eval(selector, (el) => el.textContent?.trim() ?? '')) ?? '';
  } catch {
    return '';
  }
}

async function getPhone(page: Page): Promise<string> {
  const directPhone = await getText(page, 'button[data-item-id^="phone"] .Io6YTe');
  if (directPhone) return directPhone;

  try {
    return await page.evaluate(() => {
      const phoneButton = document.querySelector('button[data-item-id^="phone"]') as HTMLElement | null;
      const rawPhone =
        phoneButton?.querySelector('.Io6YTe')?.textContent?.trim() ||
        phoneButton?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ||
        document.querySelector('[aria-label^="Phone:"]')?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '').trim() ||
        (document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null)?.href?.replace(/^tel:/i, '').trim() ||
        '';
      return rawPhone.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? rawPhone;
    });
  } catch {
    return '';
  }
}

/** Used in tests only — kept for compatibility with extractors.test.ts */
export async function extractBusinessPage(page: Page, mapsUrl: string): Promise<BusinessDetail | null> {
  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);

    const name = await getText(page, 'h1.DUwDvf');
    if (!name) return null;

    const address = await getText(page, 'button[data-item-id="address"] .Io6YTe');
    const phone = await getPhone(page);
    const websiteUrl = await getText(page, 'a[data-item-id="authority"] .Io6YTe');

    const ratingText = await getText(page, 'div.F7nice span[aria-hidden="true"]');
    const rating = ratingText ? parseFloat(ratingText) : null;
    const category = await getText(page, 'button.DkEaL');

    return { name, address, phone, category, rating, mapsUrl, websiteUrl, hasWebsite: websiteUrl.length > 0 };
  } catch {
    return null;
  }
}
