import { describe, expect, it, vi } from 'vitest';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import { parseAmazonCategoryPage } from '@/engines/amazon/scraper/category-page';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import { AmazonDeduplicationEngine } from '@/engines/amazon/scraper/dedup';
import { cardHtml, documentOf, fixture, SEARCH_URL } from './fixtures/amazon-sad-389/helpers';

describe('SAD-389: independent late sales/coupon recovery', () => {
  it.each([
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

  it('recovers the real captured card after its original sales node is restored', () => {
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

  it.each(['class', 'hidden', 'style'] as const)('recovers an attribute-only %s reveal, without rewriting settled fields', attribute => {
    const hidden = attribute === 'class' ? 'class="s-coupon-unclipped aok-hidden"' : `class="s-coupon-unclipped" ${attribute === 'hidden' ? 'hidden' : 'style="display:none"'}`;
    const d = documentOf(cardHtml(`<span ${hidden}>Save $5 with coupon</span>`, true));
    const cache = new AmazonParseCache();
    const first = parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]!;
    expect(first.coupon).toBeUndefined();
    const offer = d.querySelector('.s-coupon-unclipped')!;
    if (attribute === 'class') offer.classList.remove('aok-hidden');
    else offer.removeAttribute(attribute);
    d.querySelector('.a-price .a-offscreen')!.textContent = '$10.00';
    d.querySelector('.a-icon-alt')!.textContent = '1.0 out of 5 stars';
    const next = parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]!;
    expect(next).toEqual({ ...first, coupon: 'Save $5 with coupon' });
  });

  it('detects an equal-length text replacement that the old signature cannot see', () => {
    const value = '500+ bought in past month';
    const d = documentOf(cardHtml(`<p id="proof">${'x'.repeat(value.length)}</p>`, true));
    const cache = new AmazonParseCache();
    const first = parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]!;
    const length = d.querySelector('[data-asin]')!.textContent!.length;
    d.getElementById('proof')!.firstChild!.nodeValue = value;
    expect(d.querySelector('[data-asin]')!.textContent!.length).toBe(length);
    expect(parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]).toEqual({ ...first, pastMonthSales: value });
  });

  it('does not refresh populated targets, or borrow nested recommendation offers', () => {
    const d = documentOf(cardHtml('<p>500+ bought in past month</p><span class="s-coupon-unclipped">Save $5 with coupon</span>', true));
    const cache = new AmazonParseCache();
    const first = parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]!;
    d.querySelector('p')!.textContent = '9K+ bought in past month';
    d.querySelector('.s-coupon-unclipped')!.textContent = 'Save $9 with coupon';
    expect(parseAmazonSearchResults(d, SEARCH_URL, { cache })[0]).toEqual(first);

    const other = documentOf(cardHtml('', true));
    parseAmazonSearchResults(other, SEARCH_URL, { cache });
    other.querySelector('[data-asin]')!.insertAdjacentHTML('beforeend', '<div data-asin="B0SAD38902"><p>9K+ bought in past month</p><span class="s-coupon-unclipped">Save $9 with coupon</span></div>');
    const p = parseAmazonSearchResults(other, SEARCH_URL, { cache })[0];
    expect(p?.pastMonthSales).toBeUndefined();
    expect(p?.coupon).toBeUndefined();
  });

  it('recovers targets through the category cache without mutating its previously returned object', () => {
    const d = documentOf(cardHtml('', true));
    const cache = new AmazonParseCache();
    const existing = parseAmazonCategoryPage(d, SEARCH_URL, { cache });
    expect(existing).toHaveLength(1);
    d.querySelector('[data-asin]')!.insertAdjacentHTML('beforeend', '<p>500+ bought in past month</p><span class="s-coupon-unclipped">Save $5 with coupon</span>');
    const next = parseAmazonCategoryPage(d, SEARCH_URL, { cache });
    expect(existing[0]?.coupon).toBeUndefined();
    expect(next[0]).toMatchObject({ pastMonthSales: '500+ bought in past month', coupon: 'Save $5 with coupon' });
    expect(new AmazonDeduplicationEngine().mergeAndFilterNew(existing, next)).toMatchObject({ newProducts: [], updatedExisting: true });
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
