/**
 * SAD-383 step 3 — the rating fetch.
 *
 * Everything here is behaviour the plan promised: one request, no retry, cookies
 * omitted, the shared enrichment breaker respected, a size cap, challenge
 * detection, and the honesty guard for a non-existent ASIN (which Amazon answers
 * with `200 / 0.0 / 0 global ratings`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRatingPopover,
  isUsableRatingPayload,
  ratingPopoverUrl,
  MAX_RATING_HTML_BYTES,
} from '@/engines/amazon/background/rating-fetch';
import {
  isCircuitOpen,
  recordEnrichmentOutcome,
  resetEnrichmentCircuitForTests,
} from '@/engines/amazon/background/enrichment-fetch';

const PRODUCT_URL = 'https://www.amazon.com/dp/B0BZYCJK89';

afterEach(() => {
  resetEnrichmentCircuitForTests();
  vi.restoreAllMocks();
});

function okResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

describe('SAD-383 rating fetch', () => {
  it('builds the popover URL on the product URL’s own marketplace', () => {
    expect(ratingPopoverUrl(PRODUCT_URL, 'B0BZYCJK89')).toBe(
      'https://www.amazon.com/gp/customer-reviews/widgets/average-customer-review/popover/?ie=UTF8&asin=B0BZYCJK89',
    );
    expect(ratingPopoverUrl('https://www.amazon.de/dp/B0BZYCJK89', 'B0BZYCJK89')).toContain(
      'https://www.amazon.de/',
    );
    expect(ratingPopoverUrl('not a url', 'B0BZYCJK89')).toBeNull();
  });

  it('omits credentials and asks for exactly one page, with no retry', async () => {
    const fetchImpl = vi.fn(async () => okResponse('<html>4.6 out of 5</html>'));

    const outcome = await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ status: 'ok', html: '<html>4.6 out of 5</html>' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('follow');
  });

  it('does not retry a 5xx, a 429 or a network error', async () => {
    for (const impl of [
      async () => okResponse('', 503),
      async () => okResponse('', 429),
      async () => {
        throw new Error('offline');
      },
    ]) {
      const fetchImpl = vi.fn(impl as unknown as () => Promise<Response>);
      const outcome = await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(outcome.status).toBe('failed');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a non-Amazon product URL without any request', async () => {
    const fetchImpl = vi.fn();
    const outcome = await fetchRatingPopover('https://example.com/dp/B0BZYCJK89', 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'not-amazon' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops requesting once the shared enrichment breaker is open', async () => {
    // Three captchas in a row trip the same host breaker a PDP fetch would trip.
    for (let i = 0; i < 3; i += 1) {
      recordEnrichmentOutcome('amazon.com', 'captcha', Date.now());
    }
    expect(isCircuitOpen('amazon.com', Date.now())).toBe(true);

    const fetchImpl = vi.fn();
    const outcome = await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'circuit-open' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a challenge page as captcha and feeds the breaker', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okResponse('<html><body>Sorry, we just need to make sure you\'re not a robot</body></html>'),
      );

    const outcome = await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'captcha' });

    // Two more and the host is out of service.
    await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(isCircuitOpen('amazon.com', Date.now())).toBe(true);
  });

  it('rejects a response past the size cap', async () => {
    const fetchImpl = vi.fn(async () => okResponse('x'.repeat(MAX_RATING_HTML_BYTES + 1)));
    const outcome = await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'too-large' });
  });

  it('treats an empty body as a failure, not as "no ratings"', async () => {
    const fetchImpl = vi.fn(async () => okResponse('   '));
    const outcome = await fetchRatingPopover(PRODUCT_URL, 'B0BZYCJK89', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'empty' });
  });
});

describe('SAD-383 the honesty guard', () => {
  it('rejects the payload a non-existent ASIN produces', () => {
    // Measured 2026-10-21: asin=B0ZZZZZZZZ answers 200 with these two numbers.
    expect(isUsableRatingPayload({ rating: 0, reviewCount: 0 })).toBe(false);
    expect(isUsableRatingPayload({ rating: null, reviewCount: null })).toBe(false);
  });

  it('rejects a rating with no review count behind it', () => {
    expect(isUsableRatingPayload({ rating: 4.6, reviewCount: 0 })).toBe(false);
    expect(isUsableRatingPayload({ rating: 4.6, reviewCount: null })).toBe(false);
    expect(isUsableRatingPayload({ rating: 0, reviewCount: 12 })).toBe(false);
  });

  it('accepts a real pair, including a single-review product', () => {
    expect(isUsableRatingPayload({ rating: 4.6, reviewCount: 142457 })).toBe(true);
    expect(isUsableRatingPayload({ rating: 5, reviewCount: 1 })).toBe(true);
    expect(isUsableRatingPayload({ rating: 0.5, reviewCount: 3 })).toBe(true);
  });

  it('rejects a rating outside 0..5', () => {
    expect(isUsableRatingPayload({ rating: 7, reviewCount: 10 })).toBe(false);
  });
});
