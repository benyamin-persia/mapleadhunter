import type { Page } from 'playwright';
import { openReviewContext } from '../utils/stealth.js';
import { randomDelay } from '../utils/delays.js';
import { logger } from '../utils/logger.js';

export interface Review {
  reviewerName: string;
  reviewerUrl: string;
  reviewerRating: number | null;
  reviewDate: string;
  reviewText: string;
}

const REVIEW_SELECTOR = 'div[data-review-id], div.jftiEf, div.jJc9Ad, div[jsaction*="pane.review"]';

export async function scrapeReviews(mapsUrl: string, maxReviews = 50): Promise<Review[]> {
  const session = await openReviewContext();
  const { context } = session;
  const page = await context.newPage();
  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await randomDelay(3000, 4000);
    return await extractReviews(page, maxReviews);
  } catch (err) {
    logger.error({ err }, 'review scrape failed');
    return [];
  } finally {
    await session.close();
  }
}

export async function extractReviews(page: Page, maxReviews = 50): Promise<Review[]> {
  // Click the Reviews tab — use text matching which is stable across class changes
  const tabClicked = await clickReviewsTab(page);
  if (tabClicked) await randomDelay(1500, 2500);
  await page.waitForSelector(REVIEW_SELECTOR, { timeout: 10_000 }).catch(() => null);

  // Sort by newest (optional — helps get recent reviews)
  let visibleReviews = await countReviewCards(page);
  if (visibleReviews === 0) {
    const clickedCount = await clickReviewCount(page);
    if (clickedCount) await randomDelay(1500, 2500);
    await page.waitForSelector(REVIEW_SELECTOR, { timeout: 10_000 }).catch(() => null);
    visibleReviews = await countReviewCards(page);
  }

  // Scroll the reviews panel to load reviews.
  const scrollAttempts = Math.min(80, Math.max(15, Math.ceil(maxReviews / 4)));
  let previousCount = 0;
  let unchangedCount = 0;
  for (let i = 0; i < scrollAttempts; i++) {
    await scrollReviews(page);
    await randomDelay(700, 1000);

    const count = await countReviewCards(page);
    if (count >= maxReviews) break;
    if (count === previousCount) unchangedCount++;
    else unchangedCount = 0;
    previousCount = count;
    if (count > 0 && unchangedCount >= 8) break;
  }

  // Expand all truncated review texts
  await page.evaluate(() => {
    document.querySelectorAll('button.w8nwRe, button[jsaction*="review.expand"], button[aria-label="See more"], button[aria-label*="More"]')
      .forEach((btn) => (btn as HTMLElement).click());
  }).catch(() => null);
  await randomDelay(400, 600);

  const reviews = await page.evaluate(() => {
    // Try both selector variants — Google rotates class names
    const containers = Array.from(
      document.querySelectorAll('div[data-review-id]').length > 0
        ? document.querySelectorAll('div[data-review-id]')
        : document.querySelectorAll('div.jftiEf, div.jJc9Ad, div[jsaction*="pane.review"]'),
    );

    return containers.map((el) => {
      // Reviewer name
      const reviewerName =
        el.querySelector('.d4r55')?.textContent?.trim() ??
        el.querySelector('[class*="fontHeadlineSmall"]')?.textContent?.trim() ??
        el.querySelector('button[jsaction*="profile"]')?.textContent?.trim() ??
        el.querySelector('a[href*="contrib"]')?.textContent?.trim() ??
        '';
      const reviewerLink =
        (el.querySelector('a[href*="/maps/contrib/"], a[href*="contrib"]') as HTMLAnchorElement | null) ??
        (el.querySelector('button[jsaction*="profile"]')?.closest('a') as HTMLAnchorElement | null);
      const reviewerButton = el.querySelector('button[data-href*="/maps/contrib/"], button[data-href*="contrib"]') as HTMLElement | null;
      const reviewerUrl = reviewerLink?.href ?? reviewerButton?.getAttribute('data-href') ?? '';

      // Star rating from aria-label e.g. "4 stars"
      const ratingEl = el.querySelector('span[role="img"][aria-label*="star"]') as HTMLElement | null;
      const ratingLabel = ratingEl?.getAttribute('aria-label') ?? '';
      const ratingMatch = ratingLabel.match(/(\d+)/);
      const reviewerRating = ratingMatch ? parseInt(ratingMatch[1] ?? '0', 10) : null;

      // Date
      const reviewDate =
        el.querySelector('span.rsqaWe')?.textContent?.trim() ??
        el.querySelector('[class*="date"]')?.textContent?.trim() ??
        '';

      // Full review text (after "More" buttons expanded)
      const reviewText =
        el.querySelector('span.wiI7pd')?.textContent?.trim() ??
        el.querySelector('.MyEned span')?.textContent?.trim() ??
        el.querySelector('[class*="body"] span')?.textContent?.trim() ??
        '';

      return { reviewerName, reviewerUrl, reviewerRating, reviewDate, reviewText };
    }).filter((r) => r.reviewerName.length > 0 || r.reviewText.length > 0);
  });

  logger.info({ count: reviews.length }, 'reviews extracted');
  return reviews;
}

async function clickReviewsTab(page: Page): Promise<boolean> {
  const roleTargets = [
    page.getByRole('tab', { name: /reviews?/i }).first(),
    page.getByRole('button', { name: /reviews?/i }).first(),
    page.getByRole('link', { name: /reviews?/i }).first(),
  ];

  for (const target of roleTargets) {
    if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {
      await target.click({ timeout: 3000 }).catch(() => null);
      return true;
    }
  }

  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('button, [role="tab"], a'));
    const reviewControl = controls.find((el) => {
      const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const label = el.getAttribute('aria-label') ?? '';
      return /\breviews?\b/i.test(text) || /\breviews?\b/i.test(label);
    });
    if (!reviewControl) return false;
    (reviewControl as HTMLElement).click();
    return true;
  }).catch(() => false);
}

async function clickReviewCount(page: Page): Promise<boolean> {
  const countTargets = [
    page.getByRole('button', { name: /\d[\d,]*\s+reviews?/i }).first(),
    page.getByRole('link', { name: /\d[\d,]*\s+reviews?/i }).first(),
    page.getByText(/\d[\d,]*\s+reviews?/i).first(),
  ];

  for (const target of countTargets) {
    if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {
      await target.click({ timeout: 3000 }).catch(() => null);
      return true;
    }
  }

  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const reviewCountControl = controls.find((el) => {
      const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const label = el.getAttribute('aria-label') ?? '';
      return /\d[\d,]*\s+reviews?/i.test(text) || /\d[\d,]*\s+reviews?/i.test(label);
    });
    if (!reviewCountControl) return false;
    (reviewCountControl as HTMLElement).click();
    return true;
  }).catch(() => false);
}

async function countReviewCards(page: Page): Promise<number> {
  return page.evaluate((selector) => document.querySelectorAll(selector).length, REVIEW_SELECTOR).catch(() => 0);
}

async function scrollReviews(page: Page): Promise<void> {
  const lastReview = page.locator(REVIEW_SELECTOR).last();
  if (await lastReview.isVisible({ timeout: 1000 }).catch(() => false)) {
    await lastReview.scrollIntoViewIfNeeded().catch(() => null);
    await lastReview.hover({ timeout: 1000 }).catch(() => null);
    await page.mouse.wheel(0, 2500).catch(() => null);
  }

  await page.evaluate(scrollReviewsPanel).catch(() => null);
}

function scrollReviewsPanel(): void {
  const reviews = Array.from(document.querySelectorAll('div[data-review-id], div.jftiEf, div.jJc9Ad, div[jsaction*="pane.review"]')) as HTMLElement[];
  const lastReview = reviews[reviews.length - 1];

  if (lastReview) {
    lastReview.scrollIntoView({ block: 'end', inline: 'nearest' });

    let parent = lastReview.parentElement;
    while (parent && parent !== document.body) {
      if (parent.scrollHeight > parent.clientHeight + 20) {
        parent.scrollTop += Math.max(1200, parent.clientHeight);
      }
      parent = parent.parentElement;
    }
  }

  const candidates = [
    ...Array.from(document.querySelectorAll('[aria-label*="Reviews"]')),
    ...Array.from(document.querySelectorAll('[aria-label*="reviews"]')),
    ...Array.from(document.querySelectorAll('[aria-label*="review"]')),
    ...Array.from(document.querySelectorAll('div[role="feed"]')),
    ...Array.from(document.querySelectorAll('div.m6QErb')),
    ...Array.from(document.querySelectorAll('div[role="main"] div')),
    document.scrollingElement,
  ].filter(Boolean) as HTMLElement[];

  for (const el of candidates) {
    if (el.scrollHeight > el.clientHeight + 20) {
      el.scrollTop += Math.max(1200, el.clientHeight);
    }
  }
}
