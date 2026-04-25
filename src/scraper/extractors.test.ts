import { describe, it, expect, vi } from 'vitest';
import { extractBusinessPage } from './extractors.js';
import type { Page } from 'playwright';

function makePage(fields: Record<string, string> = {}): Page {
  const $eval = vi.fn(async (selector: string) => fields[selector] ?? '');
  const waitForTimeout = vi.fn(async () => {});
  const goto = vi.fn(async () => null);
  const waitForSelector = vi.fn(async () => null);

  return { $eval, waitForTimeout, goto, waitForSelector } as unknown as Page;
}

describe('extractBusinessPage', () => {
  it('returns null when name is empty', async () => {
    const page = makePage({});
    const result = await extractBusinessPage(page, 'https://maps.google.com/place/foo');
    expect(result).toBeNull();
  });

  it('detects hasWebsite=false when authority link is absent', async () => {
    const page = makePage({
      'h1.DUwDvf': 'Joe Plumbing',
      'button[data-item-id="address"] .Io6YTe': '123 Main St, Beverly Hills, CA 90210',
      'button[data-item-id^="phone"] .Io6YTe': '(310) 555-1234',
      'a[data-item-id="authority"] .Io6YTe': '',
    });

    const result = await extractBusinessPage(page, 'https://maps.google.com/place/foo');
    expect(result?.hasWebsite).toBe(false);
    expect(result?.name).toBe('Joe Plumbing');
    expect(result?.phone).toBe('(310) 555-1234');
  });

  it('detects hasWebsite=true when authority link is present', async () => {
    const page = makePage({
      'h1.DUwDvf': 'Jane Plumbing',
      'a[data-item-id="authority"] .Io6YTe': 'janeplumbing.com',
    });

    const result = await extractBusinessPage(page, 'https://maps.google.com/place/bar');
    expect(result?.hasWebsite).toBe(true);
  });
});
