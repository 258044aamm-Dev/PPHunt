import { describe, expect, it, vi } from 'vitest';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import { AmazonDeduplicationEngine } from '@/engines/amazon/scraper/dedup';
import { cardHtml, documentOf, fixture, SEARCH_URL } from './fixtures/amazon-sad-389/helpers';

describe('SAD-389: independent late sales/coupon recovery', () => {
  it.fails.each([
    ['rated sales', false, '<span>5K+ bought in past month</span>', 'pastMonthSales', '5K+ bought in past month'],
    ['sales with existing deal', true, '<span>5K+ bought in past month</span>', 'pastMonthSales', '5K+ bought in past month'],
    ['dollar coupon', false, '<span class="s-coupon-unclipped">Save $5 with coupon</span>', 'coupon', 'Save $5 with coupon'],
    ['percent coupon with existing deal', true, '<span class="s-coupon-unclipped">Save 25% with coupon</span>', 'coupon', 'Save 25% with coupon'],
  ] as const)('recovers %s without a new cache or a duplicate row', (_name, deal, markup, field, expected) => {
    const d = documentOf(cardHtml('', deal));
    const cache = new AmazonParseCache();
    const dedup = new AmazonDeduplicationEngine();
    const existing = parseAmazonSearchResults(d, SEARCH_URL, { cache });
    expect(existing[0]?.[field]).toBeUndefined();
    const protectedFields = { ...existing[0] };
    delete protectedFields.coupon;
    delete protectedFields.pastMonthSales;
    d.querySelector('[data-asin]')!.insertAdjacentHTML('beforeend', markup);
    const second = parseAmazonSearchResults(d, SEARCH_URL, { cache });
    expect(second[0]?.[field]).toBe(expected);
    const result = dedup.mergeAndFilterNew(existing, second);
    expect(result.newProducts).toHaveLength(0);
    expect(result.updatedExisting).toBe(true);
    const after = { ...existing[0] };
    delete after.coupon;
    delete after.pastMonthSales;
    expect(after).toEqual(protectedFields);
  });

  it.fails('recovers the real captured card after its original sales node is restored', () => {
    const d = documentOf(`<div class="s-main-slot">${fixture('search-sales.real.html')}</div>`);
    const leaf = [...d.querySelectorAll('span')].find(e => !e.children.length && /bought in past month/.test(e.textContent ?? ''))!;
    const parent = leaf.parentElement!;
    leaf.remove();
    const cache = new AmazonParseCache();
    expect(parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]?.pastMonthSales).toBeUndefined();
    parent.append(leaf);
    expect(parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]?.pastMonthSales).toBe('5K+ bought in past month');
  });

  it('retains the already-working percent-coupon recovery path', () => {
    const d = documentOf(cardHtml());
    const cache = new AmazonParseCache();
    parseAmazonSearchResults(d, SEARCH_URL, { cache });
    d.querySelector('[data-asin]')!.insertAdjacentHTML('beforeend', '<span class="s-coupon-unclipped">Save 25% with coupon</span>');
    expect(parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]?.coupon).toBe('Save 25% with coupon');
  });

  it('does no extra full parsing on unchanged cards or unrelated settled-card noise', () => {
    const d = documentOf(cardHtml('', true));
    const card = d.querySelector('[data-asin]')!;
    const product = parseAmazonSearchResults(d, SEARCH_URL, { cache: new AmazonParseCache() })[0]!;
    const parse = vi.fn(() => ({ ...product }));
    const cache = new AmazonParseCache();
    for (let i = 0; i < 5; i++) cache.getOrParse(card, parse);
    card.insertAdjacentHTML('beforeend', '<span>unrelated shipping message</span>');
    cache.getOrParse(card, parse);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
