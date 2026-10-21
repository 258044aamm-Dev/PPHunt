import { describe, expect, it } from 'vitest';
import { parseAmazonSearchCard } from '@/engines/amazon/scraper/search-results';
import { parseAmazonCategoryCard } from '@/engines/amazon/scraper/category-page';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';
import {
  createFieldDiagnosticsCollector,
  type ExtractionDiagnosticsReport,
} from '@/engines/amazon/scraper/extraction-diagnostics';
import { cardHtml, documentOf, fixture, pdpHtml, PDP_URL, SEARCH_URL, ASIN } from './fixtures/amazon-sad-389/helpers';

// it.fails pins a verified baseline defect; each is promoted to it when fixed.
describe('SAD-389: real captured positive controls', () => {
  it('preserves the real search sales and coupon strings', () => {
    const sales = documentOf(fixture('search-sales.real.html')).body.firstElementChild!;
    const coupon = documentOf(fixture('search-coupon.real.html')).body.firstElementChild!;
    expect(parseAmazonSearchCard(sales, SEARCH_URL)?.pastMonthSales).toBe('5K+ bought in past month');
    expect(parseAmazonSearchCard(coupon, SEARCH_URL)?.coupon).toBe('You pay $29.99 with coupon');
  });

  it('preserves the working split-span PDP sales badge', () => {
    const p = parseAmazonProductDetail(documentOf(pdpHtml(fixture('pdp-sales.real.html'))), PDP_URL);
    expect(p?.pastMonthSales).toBe('4K+ bought in past month');
    expect(p?.price).toBe(59.99);
  });

  it.fails('reads the real coupon label without CSS/navigation, leaving the price unchanged', () => {
    const html = pdpHtml(`<div id="apex_desktop">${fixture('pdp-coupon.real.html')}</div>`);
    const d = documentOf(html);
    const original = d.documentElement.outerHTML;
    const p = parseAmazonProductDetail(d, PDP_URL);
    expect(p?.coupon).toBe('Apply 50% coupon');
    expect(p?.price).toBe(59.99);
    expect(p?.discountPercentage).toBeUndefined();
    expect(d.documentElement.outerHTML).toBe(original);
    const offscreen = parsePdpHtml(html, PDP_URL, ASIN);
    expect(offscreen.ok).toBe(true);
    if (offscreen.ok) expect(offscreen.product.coupon).toBe('Apply 50% coupon');
  });
});

describe.each([
  ['search', parseAmazonSearchCard],
  ['category', parseAmazonCategoryCard],
] as const)('SAD-389: %s card targets', (_name, parse) => {
  const run = (extra: string) => parse(documentOf(cardHtml(extra)).querySelector('[data-asin]')!, SEARCH_URL);

  it('preserves existing amount coupons and a monthly badge', () => {
    expect(run('<span>2.5K+ bought in past month</span><span class="s-coupon-unclipped">Save $5 with coupon</span>'))
      .toMatchObject({ pastMonthSales: '2.5K+ bought in past month', coupon: 'Save $5 with coupon', price: 59.99, rating: 4.5, reviewCount: 17 });
  });

  it.fails('reads a sales signal split across two children', () => {
    expect(run('<div data-cy="reviews-block"><span>1K+</span><span> bought in past month</span></div>')?.pastMonthSales).toBe('1K+ bought in past month');
  });

  it.fails('reads a paragraph monthly-sales signal', () => {
    expect(run('<p>1K+ bought in past month</p>')?.pastMonthSales).toBe('1K+ bought in past month');
  });

  it.fails('accepts offer text without a keyword only inside a proven coupon container', () => {
    const p = run('<span class="s-coupon-unclipped">Save 15%</span>');
    expect(p?.coupon).toBe('Save 15%');
    expect(run('<span class="savingsPercentage">-15%</span>')?.coupon).toBeUndefined();
  });

  it.fails('ignores a hidden-only coupon instead of reading an inactive branch', () => {
    expect(run('<span class="s-coupon-unclipped aok-hidden">Save 15% with coupon</span>')?.coupon).toBeUndefined();
  });

  it.fails('labels an existing rejected coupon candidate PARSE_FAILED', () => {
    const reports: ExtractionDiagnosticsReport[] = [];
    parse(documentOf(cardHtml('<span class="s-coupon-unclipped">Loading offer</span>')).querySelector('[data-asin]')!, SEARCH_URL,
      { diagnosticsSink: { accept: r => reports.push(r) } });
    expect(reports[0]?.fields.find(f => f.field === 'coupon')?.status).toBe('PARSE_FAILED');
  });

  it('does not invent sales from new-on-Amazon or weekly proof, or a coupon from a discount', () => {
    const p = run('<span>New on Amazon in past month</span><span>1K+ bought in past week</span><span class="savingsPercentage">-15%</span>');
    expect(p?.pastMonthSales).toBeUndefined();
    expect(p?.coupon).toBeUndefined();
    expect(p?.discountPercentage).toBe('15% off');
  });
});

describe('SAD-389: primary-product ownership', () => {
  it.fails('does not borrow monthly sales from a recommendation anywhere on a PDP', () => {
    const html = pdpHtml('', '', '<div class="a-carousel-container"><div data-asin="B0SAD38902"><span>10K+ bought in past month</span></div></div>');
    expect(parseAmazonProductDetail(documentOf(html), PDP_URL)?.pastMonthSales).toBeUndefined();
    const parsed = parsePdpHtml(html, PDP_URL, ASIN);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.product.pastMonthSales).toBeUndefined();
  });

  it.fails('does not aggregate nested recommendation text from an allowed main-product wrapper', () => {
    const d = documentOf(pdpHtml('<div><div class="a-carousel-container"><span>10K+ bought in past month</span></div></div>'));
    expect(parseAmazonProductDetail(d, PDP_URL)?.pastMonthSales).toBeUndefined();
  });

  it.fails('excludes coupon candidates inside a nested recommendation, not just the buybox root', () => {
    const d = documentOf(pdpHtml('<div id="apex_desktop"><div class="a-carousel-container"><span class="s-coupon-unclipped">Save 25% with coupon</span></div></div>'));
    expect(parseAmazonProductDetail(d, PDP_URL)?.coupon).toBeUndefined();
  });

  it.fails('continues past an excluded first coupon to the valid primary-product candidate', () => {
    const d = documentOf(pdpHtml('<span class="couponLabelText">Apply 10% coupon</span>', '<div class="a-carousel-container"><span class="couponLabelText">Save 20% with coupon</span></div>'));
    expect(parseAmazonProductDetail(d, PDP_URL)?.coupon).toBe('Apply 10% coupon');
  });

  it('keeps truly missing fields missing with honest PDP diagnostics', () => {
    const diag = createFieldDiagnosticsCollector();
    const p = parseAmazonProductDetail(documentOf(pdpHtml('<span id="social-proofing-faceout-title-new_on_amazon">New on Amazon in past month</span>')), PDP_URL, diag);
    expect(p?.coupon).toBeUndefined();
    expect(p?.pastMonthSales).toBeUndefined();
    for (const field of ['coupon', 'pastMonthSales']) expect(diag.build().fields.find(f => f.field === field)?.status).toBe('MISSING');
  });
});
