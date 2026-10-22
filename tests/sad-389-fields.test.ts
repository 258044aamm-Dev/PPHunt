import { describe, expect, it, vi } from 'vitest';
import { parseAmazonSearchCard } from '@/engines/amazon/scraper/search-results';
import { parseAmazonCategoryCard } from '@/engines/amazon/scraper/category-page';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';
import { readAmazonPastMonthSales, readAmazonCoupon } from '@/engines/amazon/scraper/field-parsers';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';
import {
  createFieldDiagnosticsCollector,
  type ExtractionDiagnosticsReport,
} from '@/engines/amazon/scraper/extraction-diagnostics';
import { cardHtml, documentOf, fixture, pdpHtml, PDP_URL, SEARCH_URL, ASIN } from './fixtures/amazon-sad-389/helpers';

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

  it('reads the real coupon label without CSS/navigation, leaving the price unchanged', () => {
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

  it('reads a sales signal split across two children', () => {
    expect(run('<div data-cy="reviews-block"><span>1K+</span><span> bought in past month</span></div>')?.pastMonthSales).toBe('1K+ bought in past month');
  });

  it('reads a paragraph monthly-sales signal', () => {
    expect(run('<p>1K+ bought in past month</p>')?.pastMonthSales).toBe('1K+ bought in past month');
  });

  it('accepts offer text without a keyword only inside a proven coupon container', () => {
    const p = run('<span class="s-coupon-unclipped">Save 15%</span>');
    expect(p?.coupon).toBe('Save 15%');
    expect(p?.discountPercentage).toBeUndefined();
    expect(p?.price).toBe(59.99);
    expect(run('<span class="savingsPercentage">-15%</span>')?.coupon).toBeUndefined();
  });

  it('ignores a hidden-only coupon instead of reading an inactive branch', () => {
    expect(run('<span class="s-coupon-unclipped aok-hidden">Save 15% with coupon</span>')?.coupon).toBeUndefined();
  });

  it('labels an existing rejected coupon candidate PARSE_FAILED', () => {
    const reports: ExtractionDiagnosticsReport[] = [];
    parse(documentOf(cardHtml('<span class="s-coupon-unclipped">Loading offer</span>')).querySelector('[data-asin]')!, SEARCH_URL,
      { diagnosticsSink: { accept: r => reports.push(r) } });
    expect(reports[0]?.fields.find(f => f.field === 'coupon')?.status).toBe('PARSE_FAILED');
  });


  it('separates malformed numeric sales from an absent signal in diagnostics', () => {
    const reports: ExtractionDiagnosticsReport[] = [];
    const html = cardHtml('<div id="social-proofing-faceout-title-tk_bought">many bought in past month</div>');
    const card = documentOf(html).querySelector('[data-asin]')!;
    const withDiagnostics = parse(card, SEARCH_URL, { diagnosticsSink: { accept: r => reports.push(r) } });
    expect(withDiagnostics).toEqual(parse(card, SEARCH_URL));
    expect(withDiagnostics?.pastMonthSales).toBeUndefined();
    // 25 since SAD-393: `badge` joined the card report on MergeBranch
    // (24 on the SAD-389 branch, which pre-dates the badge field).
    expect(reports[0]?.fields).toHaveLength(25);
    expect(reports[0]?.fields.find(f => f.field === 'pastMonthSales')?.status).toBe('PARSE_FAILED');
  });

  it.each(['hidden', 'class="aok-hidden"', 'style="display:none"', 'style="visibility:hidden"'])('skips inactive descendants (%s), not a visible sibling', attr => {
    const p = run(`<div ${attr}><span>9K+ bought in past month</span><span class="s-coupon-unclipped">Save 90% with coupon</span></div><p>500+ bought in past month</p><span class="s-coupon-unclipped">Save $5 with coupon</span>`);
    expect(p).toMatchObject({ pastMonthSales: '500+ bought in past month', coupon: 'Save $5 with coupon' });
  });

  it('retains visible aria-hidden text and excludes scripts/styles/templates', () => {
    const p = run('<style>.x { content:"99K+ bought in past month" }</style><template><span>99K+ bought in past month</span></template><span aria-hidden="true">500+ bought in past month</span><span class="s-coupon-unclipped" aria-hidden="true">Save 5% with coupon</span>');
    expect(p).toMatchObject({ pastMonthSales: '500+ bought in past month', coupon: 'Save 5% with coupon' });
  });

  it('never attributes a nested different-ASIN offer to this card', () => {
    const p = run('<div data-asin="B0SAD38902"><span>9K+ bought in past month</span><span class="s-coupon-unclipped">Save 90% with coupon</span></div>');
    expect(p?.pastMonthSales).toBeUndefined();
    expect(p?.coupon).toBeUndefined();
  });

  it('does not invent sales from new-on-Amazon or weekly proof, or a coupon from a discount', () => {
    const p = run('<span>New on Amazon in past month</span><span>1K+ bought in past week</span><span class="savingsPercentage">-15%</span>');
    expect(p?.pastMonthSales).toBeUndefined();
    expect(p?.coupon).toBeUndefined();
    expect(p?.discountPercentage).toBe('15% off');
  });
});

describe('SAD-389: primary-product ownership', () => {
  it('does not borrow monthly sales from a recommendation anywhere on a PDP', () => {
    const html = pdpHtml('', '', '<div class="a-carousel-container"><div data-asin="B0SAD38902"><span>10K+ bought in past month</span></div></div>');
    expect(parseAmazonProductDetail(documentOf(html), PDP_URL)?.pastMonthSales).toBeUndefined();
    const parsed = parsePdpHtml(html, PDP_URL, ASIN);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.product.pastMonthSales).toBeUndefined();
  });

  it('does not aggregate nested recommendation text from an allowed main-product wrapper', () => {
    const d = documentOf(pdpHtml('<div><div class="a-carousel-container"><span>10K+ bought in past month</span></div></div>'));
    expect(parseAmazonProductDetail(d, PDP_URL)?.pastMonthSales).toBeUndefined();
  });

  it('excludes coupon candidates inside a nested recommendation, not just the buybox root', () => {
    const d = documentOf(pdpHtml('<div id="apex_desktop"><div class="a-carousel-container"><span class="s-coupon-unclipped">Save 25% with coupon</span></div></div>'));
    expect(parseAmazonProductDetail(d, PDP_URL)?.coupon).toBeUndefined();
  });

  it('continues past an excluded first coupon to the valid primary-product candidate', () => {
    const d = documentOf(pdpHtml('<span class="couponLabelText">Apply 10% coupon</span>', '<div class="a-carousel-container"><span class="couponLabelText">Save 20% with coupon</span></div>'));
    expect(parseAmazonProductDetail(d, PDP_URL)?.coupon).toBe('Apply 10% coupon');
  });


  it('continues past hidden/rejected sales markers and reports the valid primary node', () => {
    const d = documentOf(pdpHtml('<div id="social-proofing-faceout-title-tk_bought"><span>2K+</span><span>bought in past month</span></div>', '<div hidden><span id="social-proofing-faceout-title-tk_bought">9K+ bought in past month</span></div>'));
    const diag = createFieldDiagnosticsCollector();
    expect(parseAmazonProductDetail(d, PDP_URL, diag)?.pastMonthSales).toBe('2K+ bought in past month');
    expect(diag.build().fields.find(f => f.field === 'pastMonthSales')).toMatchObject({ status: 'EXTRACTED', source: 'dom' });
  });

  it('does not count coupon-only percentages as discounts in the PDP fallback scan', () => {
    const p = parseAmazonProductDetail(documentOf(pdpHtml('<span class="couponLabelText"><b>Save 15%</b></span>')), PDP_URL);
    expect(p?.coupon).toBe('Save 15%');
    expect(p?.discountPercentage).toBeUndefined();
    expect(p?.price).toBe(59.99);
  });

  it('reports rejected PDP offer text instead of calling it absent', () => {
    const diag = createFieldDiagnosticsCollector();
    const p = parseAmazonProductDetail(documentOf(pdpHtml('<span class="couponLabelText">Loading offer</span><span id="social-proofing-faceout-title-tk_bought">many bought in past month</span>')), PDP_URL, diag);
    expect(p?.coupon).toBeUndefined();
    expect(p?.pastMonthSales).toBeUndefined();
    for (const field of ['coupon', 'pastMonthSales']) expect(diag.build().fields.find(f => f.field === field)?.status).toBe('PARSE_FAILED');
  });

  it('keeps truly missing fields missing with honest PDP diagnostics', () => {
    const diag = createFieldDiagnosticsCollector();
    const p = parseAmazonProductDetail(documentOf(pdpHtml('<span id="social-proofing-faceout-title-new_on_amazon">New on Amazon in past month</span>')), PDP_URL, diag);
    expect(p?.coupon).toBeUndefined();
    expect(p?.pastMonthSales).toBeUndefined();
    for (const field of ['coupon', 'pastMonthSales']) expect(diag.build().fields.find(f => f.field === field)?.status).toBe('MISSING');
  });
});


describe('SAD-389: cheap readers preserve diagnostics and selector priority', () => {
  it('does no broad selector scan for cards with no monthly-sales evidence', () => {
    const card = documentOf(cardHtml()).querySelector('[data-asin]')!;
    const scan = vi.spyOn(card, 'querySelectorAll');
    expect(readAmazonPastMonthSales(card)).toEqual({ nodeSeen: false });
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  it('still observes explicit empty/loading sales markers, including a root marker', () => {
    const d = documentOf('<div id="social-proofing-faceout-title-tk_bought">Loading</div>');
    expect(readAmazonPastMonthSales(d)).toMatchObject({ nodeSeen: true });
    expect(readAmazonPastMonthSales(d.body.firstElementChild!)).toMatchObject({ nodeSeen: true });
  });

  it('keeps coupon selector priority independent of DOM order with only one candidate query', () => {
    const d = documentOf(cardHtml('<span class="couponLabelText">Apply 10% coupon</span><span class="s-coupon-unclipped">Save $5 with coupon</span>'));
    const card = d.querySelector('[data-asin]')!;
    const scan = vi.spyOn(card, 'querySelectorAll');
    expect(readAmazonCoupon(card).value).toBe('Save $5 with coupon');
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockRestore();
  });
});
