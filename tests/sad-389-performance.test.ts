import { describe, expect, it, vi } from 'vitest';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import { extractCardPricingAndDiscounts } from '@/engines/amazon/scraper/field-parsers';
import { cardHtml, documentOf, SEARCH_URL, ASIN } from './fixtures/amazon-sad-389/helpers';

describe('SAD-389: many inactive coupons do not defeat the cache budget', () => {
  it('keeps 480 hidden offers cheap, then recovers them without a full-card reparse', () => {
    const html = Array.from({ length: 480 }, (_, i) => {
      const asin = `B0BEN${String(i).padStart(5, '0')}`;
      return cardHtml('<span class="s-coupon-unclipped aok-hidden">Save $5 with coupon</span>', true)
        .replace('<div class="s-main-slot">', '').replace(/<\/div>$/, '').replaceAll(ASIN, asin);
    }).join('');
    const d = documentOf(`<div class="s-main-slot">${html}</div>`);
    const cache = new AmazonParseCache();
    const pricing = vi.fn(extractCardPricingAndDiscounts);
    const options = { cache, extractPricing: pricing };
    const start = performance.now();
    const initial = parseAmazonSearchResults(d, SEARCH_URL, options);
    const coldMs = performance.now() - start;
    expect(initial).toHaveLength(480);
    expect(initial.every(p => !p.coupon)).toBe(true);
    expect(pricing).toHaveBeenCalledTimes(480);
    pricing.mockClear();
    const warmStart = performance.now();
    expect(parseAmazonSearchResults(d, SEARCH_URL, options)).toHaveLength(480);
    const warmMs = performance.now() - warmStart;
    expect(pricing).not.toHaveBeenCalled();
    for (const e of d.querySelectorAll('.s-coupon-unclipped')) e.classList.remove('aok-hidden');
    const recoveryStart = performance.now();
    const recovered = parseAmazonSearchResults(d, SEARCH_URL, options);
    const recoveryMs = performance.now() - recoveryStart;
    expect(recovered.every(p => p.coupon === 'Save $5 with coupon' && p.price === 59.99 && p.rating === 4.5)).toBe(true);
    expect(pricing).not.toHaveBeenCalled();
    console.info('SAD389_PERFORMANCE', JSON.stringify({ cards: 480, coldMs, warmMs, recoveryMs, warmFullParses: pricing.mock.calls.length }));
    expect(coldMs).toBeLessThan(4000);
    expect(warmMs).toBeLessThan(coldMs / 4);
  }, 30_000);
});
