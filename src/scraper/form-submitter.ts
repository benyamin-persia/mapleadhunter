import { launchStealthBrowser, newStealthContext } from '../utils/stealth.js';
import { randomDelay } from '../utils/delays.js';
import { logger } from '../utils/logger.js';

export interface FormSender {
  name: string;
  email: string;
  phone: string;
  message: string;
}

export interface FormResult {
  success: boolean;
  submitted: boolean;
  error?: string;
}

export async function submitContactForm(contactUrl: string, sender: FormSender): Promise<FormResult> {
  const browser = await launchStealthBrowser();
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  try {
    await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await randomDelay(1200, 2000);

    const filled = await page.evaluate((s: FormSender) => {
      const form = document.querySelector('form');
      if (!form) return { ok: false, reason: 'no form found' };

      const fill = (el: HTMLInputElement | HTMLTextAreaElement | null, val: string) => {
        if (!el) return;
        el.focus();
        (el as HTMLInputElement).value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      };

      const nameEl = (
        form.querySelector('input[name="name" i]') ??
        form.querySelector('input[name*="fullname" i]') ??
        form.querySelector('input[placeholder*="your name" i]') ??
        form.querySelector('input[id*="name" i]') ??
        form.querySelector('input[type="text"]')
      ) as HTMLInputElement | null;
      fill(nameEl, s.name);

      const emailEl = (
        form.querySelector('input[type="email"]') ??
        form.querySelector('input[name*="email" i]') ??
        form.querySelector('input[placeholder*="email" i]')
      ) as HTMLInputElement | null;
      fill(emailEl, s.email);

      const phoneEl = (
        form.querySelector('input[type="tel"]') ??
        form.querySelector('input[name*="phone" i]') ??
        form.querySelector('input[name*="tel" i]') ??
        form.querySelector('input[placeholder*="phone" i]')
      ) as HTMLInputElement | null;
      fill(phoneEl, s.phone);

      const msgEl = (
        form.querySelector('textarea') ??
        form.querySelector('input[name*="message" i]') ??
        form.querySelector('input[name*="comment" i]')
      ) as HTMLTextAreaElement | HTMLInputElement | null;
      fill(msgEl, s.message);

      if (!msgEl) return { ok: false, reason: 'no message field found' };

      return { ok: true, reason: '' };
    }, sender);

    if (!filled.ok) return { success: false, submitted: false, error: filled.reason };

    await randomDelay(800, 1200);

    const submitted = await page.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return false;
      const btn = (
        form.querySelector('button[type="submit"]') ??
        form.querySelector('input[type="submit"]') ??
        form.querySelector('button:not([type="button"]):not([type="reset"])') ??
        document.querySelector('[class*="submit" i]')
      ) as HTMLElement | null;
      if (btn) { btn.click(); return true; }
      form.submit();
      return true;
    });

    if (!submitted) return { success: false, submitted: false, error: 'submit button not found' };

    await randomDelay(2000, 3000);
    logger.info({ url: contactUrl }, 'contact form submitted');
    return { success: true, submitted: true };
  } catch (err) {
    logger.error({ err, url: contactUrl }, 'form submission failed');
    return { success: false, submitted: false, error: String(err) };
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}
