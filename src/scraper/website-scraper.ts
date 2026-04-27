import { launchStealthBrowser, newStealthContext } from '../utils/stealth.js';
import { logger } from '../utils/logger.js';

export interface WebsiteData {
  emails: string[];
  phones: string[];
  socialLinks: { platform: string; url: string }[];
  contactUrl: string;
  hasContactForm: boolean;
  ogImage: string;
}

// Pages to prioritize when crawling (higher score = visited first)
const PRIORITY_KEYWORDS = ['contact', 'about', 'team', 'staff', 'reach', 'touch', 'connect', 'hire', 'appointment', 'booking', 'support', 'help', 'location', 'find-us', 'info'];

// Highest-confidence contact paths — kept short so 404s don't eat the page budget.
// Link discovery fills in the rest during crawling.
const COMMON_CONTACT_PATHS = [
  '/contact', '/contact-us', '/pages/contact-us',
  '/about', '/about-us', '/pages/about-us',
  '/location', '/locations',
];

const SOCIAL_PATTERNS = [
  { pattern: 'facebook.com', platform: 'Facebook' },
  { pattern: 'instagram.com', platform: 'Instagram' },
  { pattern: 'twitter.com', platform: 'Twitter' },
  { pattern: 'x.com', platform: 'Twitter' },
  { pattern: 'linkedin.com', platform: 'LinkedIn' },
  { pattern: 'youtube.com', platform: 'YouTube' },
  { pattern: 'tiktok.com', platform: 'TikTok' },
  { pattern: 'yelp.com', platform: 'Yelp' },
  { pattern: 'pinterest.com', platform: 'Pinterest' },
  { pattern: 'nextdoor.com', platform: 'Nextdoor' },
];

type SocialPattern = { pattern: string; platform: string };

function normalizeUrl(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Strip fragments only from discovered crawl links (avoids duplicate visits).
    // The starting URL keeps its hash so SPA distributors/routes load correctly.
    return u.href.split('#')[0] ?? null;
  } catch { return null; }
}

// Return the registered apex domain (last two hostname segments).
// Handles www.example.com → example.com, shop.example.com → example.com.
// Falls back to full hostname for unusual TLDs — good enough for US local businesses.
function apexDomain(hostname: string): string {
  const parts = hostname.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : hostname;
}

// Allow same apex domain so www/non-www and subdomains all link freely.
// Cross-domain redirects are handled separately by updating baseRoot at runtime.
function isSameDomain(url: string, base: string): boolean {
  try {
    return apexDomain(new URL(url).hostname) === apexDomain(new URL(base).hostname);
  } catch { return false; }
}

function priorityScore(url: string): number {
  const lower = url.toLowerCase();
  return PRIORITY_KEYWORDS.reduce((score, kw) => lower.includes(kw) ? score + 1 : score, 0);
}

async function extractPageData(page: { evaluate: Function; url: () => string }, patterns: SocialPattern[]) {
  // IMPORTANT: no named inner functions (const fn = ...) inside page.evaluate —
  // esbuild injects __name() for them which crashes in the browser context.
  // All logic must be inlined.
  return page.evaluate((pts: SocialPattern[]) => {
    const phones: string[] = [];
    const emails: string[] = [];
    const socialLinks: { platform: string; url: string }[] = [];
    const internalLinks: string[] = [];
    let contactUrl = '';
    let hasContactForm = false;
    let ogImage = '';

    const phoneAttrRx = /^[\d\s().+\-]{7,20}$/;

    // ── 1. tel: links ─────────────────────────────────────────────────────
    document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
      const raw = (a as HTMLAnchorElement).href.replace(/^tel:/i, '').trim();
      const d = raw.replace(/\D/g, '');
      if (d.length >= 10 && d.length <= 15 && !phones.includes(raw)) phones.push(raw);
    });

    // ── 2. mailto: links ──────────────────────────────────────────────────
    document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
      const raw = (a as HTMLAnchorElement).href.replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase() ?? '';
      if (raw.includes('@') && !raw.match(/\.(png|jpg|gif|svg|webp|css|js)$/i) && !raw.includes('example') && !emails.includes(raw))
        emails.push(raw);
    });

    // ── 3. data-phone / data-tel / meta telephone attributes ──────────────
    document.querySelectorAll('[data-phone],[data-tel],[data-number],[data-contact]').forEach((el) => {
      ['data-phone', 'data-tel', 'data-number', 'data-contact'].forEach((attr) => {
        const v = el.getAttribute(attr)?.trim() ?? '';
        if (phoneAttrRx.test(v) && v.replace(/\D/g,'').length >= 10 && !phones.includes(v)) phones.push(v);
      });
    });
    document.querySelectorAll('input[type="tel"],input[name*="phone" i],input[name*="tel" i]').forEach((el) => {
      const v = (el as HTMLInputElement).value?.trim() ?? '';
      const d = v.replace(/\D/g,'');
      if (d.length >= 10 && !phones.includes(v)) phones.push(v);
    });
    document.querySelectorAll('meta[name*="phone" i],meta[property*="phone" i],meta[itemprop="telephone"]').forEach((el) => {
      const v = el.getAttribute('content')?.trim() ?? '';
      const d = v.replace(/\D/g,'');
      if (d.length >= 10 && !phones.includes(v)) phones.push(v);
    });

    // ── 4. JSON-LD structured data — stack-based walk, no recursion fn ────
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const stack: unknown[] = [JSON.parse(s.textContent ?? '')];
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== 'object') continue;
          const o = node as Record<string, unknown>;
          if (typeof o['telephone'] === 'string' && !phones.includes(o['telephone'])) phones.push(o['telephone']);
          if (typeof o['faxNumber'] === 'string' && !phones.includes(o['faxNumber'])) phones.push(o['faxNumber']);
          if (typeof o['email'] === 'string') {
            const e = o['email'].toLowerCase();
            if (e.includes('@') && !emails.includes(e)) emails.push(e);
          }
          if (Array.isArray(node)) node.forEach((v) => stack.push(v));
          else Object.values(o).forEach((v) => stack.push(v));
        }
      } catch { /* skip malformed JSON-LD */ }
    });

    // ── 5. Regex scan of rendered text ────────────────────────────────────
    const text = document.body?.innerText ?? '';
    let m: RegExpExecArray | null;
    const pr1 = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
    while ((m = pr1.exec(text)) !== null) {
      const p = m[0].trim(); const d = p.replace(/\D/g,'');
      if (d.length >= 10 && !phones.includes(p)) phones.push(p);
    }
    const er1 = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    while ((m = er1.exec(text)) !== null) {
      const e = m[0].toLowerCase();
      if (!e.match(/\.(png|jpg|gif|svg|webp|css|js)$/i) && !e.includes('example') && !emails.includes(e)) emails.push(e);
    }
    // Obfuscated: name [at] domain [dot] com
    const obfRx = /([a-zA-Z0-9._%+\-]+)\s*[\[(]?at[\])]?\s*([a-zA-Z0-9.\-]+)\s*[\[(]?dot[\])]?\s*([a-zA-Z]{2,})/gi;
    while ((m = obfRx.exec(text)) !== null) {
      const e = (m[1] + '@' + m[2] + '.' + m[3]).toLowerCase();
      if (!emails.includes(e)) emails.push(e);
    }

    // ── 6. Raw HTML scan — catches hidden spans, comments, script data ────
    const html = document.documentElement.outerHTML;
    const pr2 = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
    while ((m = pr2.exec(html)) !== null) {
      const p = m[0].trim(); const d = p.replace(/\D/g,'');
      if (d.length >= 10 && !phones.includes(p)) phones.push(p);
    }
    const er2 = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    while ((m = er2.exec(html)) !== null) {
      const e = m[0].toLowerCase();
      if (!e.match(/\.(png|jpg|gif|svg|webp|css|js)$/i) && !e.includes('example') && !emails.includes(e)) emails.push(e);
    }

    // ── 7. Same-origin iframes ────────────────────────────────────────────
    document.querySelectorAll('iframe').forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const iText = doc.body?.innerText ?? '';
        const ipr = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
        while ((m = ipr.exec(iText)) !== null) {
          const p = m[0].trim(); const d = p.replace(/\D/g,'');
          if (d.length >= 10 && !phones.includes(p)) phones.push(p);
        }
        doc.querySelectorAll('a[href^="tel:"]').forEach((a) => {
          const raw = (a as HTMLAnchorElement).href.replace(/^tel:/i,'').trim();
          const d = raw.replace(/\D/g,'');
          if (d.length >= 10 && !phones.includes(raw)) phones.push(raw);
        });
        doc.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
          const e = (a as HTMLAnchorElement).href.replace(/^mailto:/i,'').split('?')[0]?.trim().toLowerCase() ?? '';
          if (e.includes('@') && !emails.includes(e)) emails.push(e);
        });
      } catch { /* cross-origin — blocked */ }
    });

    // ── 8. Social links — a[href], data attrs, onclick, raw HTML (all inlined — no named fns) ──
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = (a as HTMLAnchorElement).href ?? '';
      if (!href) return;
      for (let si8 = 0; si8 < pts.length; si8++) {
        const sp = pts[si8]!;
        if (href.includes(sp.pattern) && !socialLinks.find((s) => s.platform === sp.platform)) {
          socialLinks.push({ platform: sp.platform, url: href }); break;
        }
      }
    });
    document.querySelectorAll('[data-href],[data-url],[data-link]').forEach((el) => {
      const href = el.getAttribute('data-href') ?? el.getAttribute('data-url') ?? el.getAttribute('data-link') ?? '';
      if (!href) return;
      for (let si8 = 0; si8 < pts.length; si8++) {
        const sp = pts[si8]!;
        if (href.includes(sp.pattern) && !socialLinks.find((s) => s.platform === sp.platform)) {
          socialLinks.push({ platform: sp.platform, url: href }); break;
        }
      }
    });
    document.querySelectorAll('[onclick]').forEach((el) => {
      const ocm = (el.getAttribute('onclick') ?? '').match(/https?:\/\/[^\s'"]+/);
      const href = ocm?.[0] ?? '';
      if (!href) return;
      for (let si8 = 0; si8 < pts.length; si8++) {
        const sp = pts[si8]!;
        if (href.includes(sp.pattern) && !socialLinks.find((s) => s.platform === sp.platform)) {
          socialLinks.push({ platform: sp.platform, url: href }); break;
        }
      }
    });
    const socialRx = /https?:\/\/[^\s"'<>)\]]*(?:facebook|instagram|twitter|linkedin|youtube|tiktok|yelp|pinterest)\.com\/[^\s"'<>)\]]+/gi;
    let socialM: RegExpExecArray | null;
    const htmlForSocial = document.documentElement.innerHTML;
    while ((socialM = socialRx.exec(htmlForSocial)) !== null) {
      const href = socialM[0] ?? '';
      if (!href) continue;
      for (let si8 = 0; si8 < pts.length; si8++) {
        const sp = pts[si8]!;
        if (href.includes(sp.pattern) && !socialLinks.find((s) => s.platform === sp.platform)) {
          socialLinks.push({ platform: sp.platform, url: href }); break;
        }
      }
    }

    // ── 9. Internal links ─────────────────────────────────────────────────
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = (a as HTMLAnchorElement).href ?? '';
      if (href && !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.includes('#') && !internalLinks.includes(href))
        internalLinks.push(href);
    });

    // ── 10. Contact page detection ────────────────────────────────────────
    const contactKws = ['contact', 'get in touch', 'reach us', 'reach out', 'talk to us', 'hire us', 'book', 'appointment'];
    document.querySelectorAll('a[href]').forEach((a) => {
      if (contactUrl) return;
      const el = a as HTMLAnchorElement;
      const txt = (el.textContent ?? '').toLowerCase().trim();
      const href = (el.href ?? '').toLowerCase();
      for (let ki = 0; ki < contactKws.length; ki++) {
        if (txt.includes(contactKws[ki]!) || href.includes(contactKws[ki]!)) { contactUrl = el.href; break; }
      }
    });

    // ── 11. Contact form detection ────────────────────────────────────────
    document.querySelectorAll('form').forEach((form) => {
      if (!hasContactForm && form.querySelector('input[type="email"],input[name*="email" i],textarea,input[type="tel"]'))
        hasContactForm = true;
    });

    ogImage =
      (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)?.content ||
      (document.querySelector('meta[name="twitter:image"]') as HTMLMetaElement | null)?.content ||
      (document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement | null)?.href ||
      '';

    return { phones, emails, socialLinks, internalLinks, contactUrl, hasContactForm, ogImage };
  }, patterns);
}

function isValidNANP(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  const d10 = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (d10.length !== 10) return false;
  const area = d10.slice(0, 3);
  const exchange = d10.slice(3, 6);
  if (area[0] === '0' || area[0] === '1') return false; // invalid area code
  if (exchange[0] === '0' || exchange[0] === '1') return false; // invalid exchange
  if (area === '555') return false; // reserved/fake
  if (/^(\d)\1{9}$/.test(d10)) return false; // all same digit e.g. 0000000000
  if (d10 === '1234567890' || d10 === '0123456789') return false;
  return true;
}

export async function scrapeWebsite(websiteUrl: string): Promise<WebsiteData> {
  const empty: WebsiteData = { emails: [], phones: [], socialLinks: [], contactUrl: '', hasContactForm: false, ogImage: '' };

  const browser = await launchStealthBrowser();
  const context = await newStealthContext(browser);

  const allEmails = new Set<string>();
  const allPhones = new Set<string>();
  const allSocials = new Map<string, string>(); // platform → url
  let contactUrl = '';
  let hasContactForm = false;
  let ogImage = '';

  const visited = new Set<string>();
  const MAX_PAGES = 15;

  try {
    // Preserve full URL including hash fragment — SPA sites (e.g. Tower Garden
    // distributor pages like /#dc97970) render their content based on the hash.
    const base = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
    // For same-domain checks and link normalisation, use the hash-stripped root.
    // baseRoot may be updated after the first page if the site 301-redirects
    // to a different domain (e.g. myendlessgarden.com → dc97970.towergarden.com).
    let baseRoot = base.split('#')[0]!;

    // Queue: start with the full URL (hash intact), then discover more.
    const queue: { url: string; priority: number; isFirst: boolean }[] = [{ url: base, priority: 99, isFirst: true }];

    // Also always queue the site root — the stored URL may be a deep page
    // (e.g. /products/item) while the phone lives in the homepage footer.
    const siteRoot = (() => { try { const u = new URL(baseRoot); return u.origin + '/'; } catch { return null; } })();
    if (siteRoot && siteRoot !== baseRoot) queue.push({ url: siteRoot, priority: 50, isFirst: false });

    // Pre-inject common contact/about paths for every site.
    const injectContactPaths = (root: string) => {
      // Remove any stale queue entries pointing to a different domain
      // (happens after a cross-domain redirect is detected mid-crawl).
      const rootApex = apexDomain(new URL(root).hostname);
      for (let i = queue.length - 1; i >= 0; i--) {
        try {
          if (apexDomain(new URL(queue[i]!.url).hostname) !== rootApex) queue.splice(i, 1);
        } catch { queue.splice(i, 1); }
      }
      for (const path of COMMON_CONTACT_PATHS) {
        try {
          const url = new URL(path, root).href;
          if (!queue.find(q => q.url === url) && !visited.has(url))
            queue.push({ url, priority: 8, isFirst: false });
        } catch { /* skip malformed */ }
      }
    };
    injectContactPaths(baseRoot);

    while (queue.length > 0 && visited.size < MAX_PAGES) {
      // Sort by priority, take highest
      queue.sort((a, b) => b.priority - a.priority);
      const next = queue.shift()!;
      // Dedup by hash-stripped URL so we don't re-visit the same page via different anchors
      const dedupeKey = next.url.split('#')[0]!;
      if (visited.has(dedupeKey)) continue;
      visited.add(dedupeKey);

      let page: Awaited<ReturnType<typeof context.newPage>> | null = null;
      try {
        page = await context.newPage();

        // Try networkidle first — catches SPA renders and async data fetches.
        // Fall back to domcontentloaded if the site never goes idle.
        const response = await page.goto(next.url, { waitUntil: 'networkidle', timeout: 20_000 })
          .catch(() => page!.goto(next.url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null));

        // Skip truly dead pages, but be careful with 403 — some sites return 403
        // to fetch() but Playwright stealth still gets real content. Only skip if
        // the page body is also empty/minimal (real error page).
        const status = response?.status() ?? 200;
        if (!next.isFirst && (status === 404 || status === 410)) {
          logger.debug({ url: next.url, status }, 'skipping dead page');
          await page.close().catch(() => null);
          continue;
        }
        if (!next.isFirst && status === 403) {
          const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
          if (bodyLen < 200) {
            logger.debug({ url: next.url, status }, 'skipping 403 with no content');
            await page.close().catch(() => null);
            continue;
          }
        }

        // Detect cross-domain redirects (e.g. myendlessgarden.com → dc97970.towergarden.com).
        // Update baseRoot so link discovery and isSameDomain use the landed domain, not the original.
        if (next.isFirst) {
          const landedUrl = page.url().split('#')[0]!;
          try {
            const landedHost = new URL(landedUrl).hostname;
            const originalHost = new URL(baseRoot).hostname;
            if (landedHost !== originalHost) {
              logger.info({ original: originalHost, landed: landedHost }, 'cross-domain redirect detected — updating base');
              baseRoot = landedUrl;
              // Re-inject contact paths relative to the new domain
              injectContactPaths(baseRoot);
            }
          } catch { /* keep original */ }
        }

        // Extra wait for hash-routed SPAs and lazy loaders
        const extraWait = next.url.includes('#') ? 3000 : 1500;
        await page.waitForTimeout(extraWait).catch(() => null);

        // Scroll to bottom to trigger lazy-loaded contact sections
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => null);
        await page.waitForTimeout(600).catch(() => null);

        // Click any "show phone / reveal number" buttons before extracting.
        // Many local business sites hide the number behind a click-to-reveal.
        await page.evaluate(() => {
          document.querySelectorAll('button, a, span, div').forEach((el) => {
            const txt = (el.textContent ?? '').toLowerCase().trim();
            if (txt.match(/show\s*(phone|number|tel)|reveal|click\s*to\s*call|click\s*for\s*phone/i)) {
              (el as HTMLElement).click();
            }
          });
        }).catch(() => null);
        await page.waitForTimeout(600).catch(() => null);

        const data = await extractPageData(page, SOCIAL_PATTERNS).catch(() => null);
        if (!data) { await page.close().catch(() => null); continue; }

        // Collect results
        data.emails.forEach((e: string) => allEmails.add(e));
        data.phones.forEach((p: string) => allPhones.add(p));
        data.socialLinks.forEach((s: { platform: string; url: string }) => { if (!allSocials.has(s.platform)) allSocials.set(s.platform, s.url); });
        if (!contactUrl && data.contactUrl) contactUrl = data.contactUrl;
        if (!ogImage && data.ogImage) ogImage = data.ogImage;
        if (data.hasContactForm) {
          hasContactForm = true;
          if (!contactUrl) contactUrl = next.url;
        }

        // Enqueue discovered internal links not yet visited
        for (const link of data.internalLinks) {
          const normalized = normalizeUrl(link, baseRoot);
          if (!normalized || !isSameDomain(normalized, baseRoot) || visited.has(normalized)) continue;
          if (queue.find((q) => q.url === normalized)) continue;
          queue.push({ url: normalized, priority: priorityScore(normalized), isFirst: false });
        }
      } catch (err) {
        logger.debug({ url: next.url, err }, 'page visit failed — skipping');
      } finally {
        await page?.close().catch(() => null);
      }
    }

    const result: WebsiteData = {
      emails: [...allEmails].filter((e) => e.length < 100),
      phones: [...allPhones].filter(isValidNANP).slice(0, 5),
      socialLinks: [...allSocials.entries()].map(([platform, url]) => ({ platform, url })),
      contactUrl,
      hasContactForm,
      ogImage,
    };

    logger.info({ url: base, pages: visited.size, emails: result.emails.length, phones: result.phones.length, hasForm: result.hasContactForm }, 'website crawl done');
    return result;
  } catch (err) {
    logger.error({ err, url: websiteUrl }, 'website scrape failed');
    return empty;
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}
