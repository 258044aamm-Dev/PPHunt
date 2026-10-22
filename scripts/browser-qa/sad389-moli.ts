// Native Moli verification, not an installed Chrome extension test.
// All controlled mutations are on detached documents/cloned cards.
import { parseAmazonSearchResults, parseAmazonSearchCard } from '../../src/engines/amazon/scraper/search-results';
import { parseAmazonProductDetail } from '../../src/engines/amazon/scraper/product-detail';
import { AmazonParseCache } from '../../src/engines/amazon/scraper/parse-cache';
import { parsePdpHtml } from '../../src/engines/amazon/offscreen/parse';
import { AMAZON_COLLECTION_OBSERVER_OPTIONS, isRelevantAmazonCollectionMutation } from '../../src/engines/amazon/content/collection-mutations';

declare const __SAD389_COMMIT__: string;
declare const __SAD389_COUPON_FIXTURE__: string;
const ASIN = 'B0SAD38901';
const SEARCH = 'https://www.amazon.com/s?k=wireless+earbuds&language=en_US';
const PDP = `https://www.amazon.com/dp/${ASIN}`;
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const pick = (p: any) => p ? { asin: p.asin, price: p.price, listPrice: p.listPrice ?? null, discountPercentage: p.discountPercentage ?? null, dealBadge: p.dealBadge ?? null, rating: p.rating, reviewCount: p.reviewCount, pastMonthSales: p.pastMonthSales ?? null, coupon: p.coupon ?? null } : null;
const card = (extra = '', deal = false) => doc(`<div class="s-main-slot"><div data-component-type="s-search-result" data-asin="${ASIN}"><h2><a href="/dp/${ASIN}">Controlled earbuds</a></h2><span class="a-price"><span class="a-offscreen">$59.99</span></span><img class="s-image" src="https://m.media-amazon.com/images/I/sad389.jpg"><span class="a-icon-alt">4.5 out of 5 stars</span><span aria-label="17 ratings">17 ratings</span>${deal ? '<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$79.99</span></span>' : ''}${extra}</div></div>`);
const detail = (middle = '', before = '', after = '') => `<html><head><link rel="canonical" href="${PDP}"></head><body>${before}<div id="centerCol"><h1 id="productTitle">Controlled product</h1><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$59.99</span></span></div>${middle}</div>${after}</body></html>`;

async function run() {
  const checks: Array<{ name: string; evidence: string; actual: unknown; expected: unknown; pass: boolean }> = [];
  const check = (name: string, actual: unknown, expected: unknown, evidence = 'controlled native DOM') => {
    checks.push({ name, evidence, actual, expected, pass: JSON.stringify(actual) === JSON.stringify(expected) });
  };
  const products = /\/(dp|gp\/product)\//.test(location.pathname)
    ? [parseAmazonProductDetail(document, location.href)].filter(Boolean)
    : parseAmazonSearchResults(document, location.href, { cache: new AmazonParseCache() });

  for (const [name, withDeal, field, markup, expected] of [
    ['late_sales', false, 'pastMonthSales', '<p>5K+ bought in past month</p>', '5K+ bought in past month'],
    ['late_sales_with_deal', true, 'pastMonthSales', '<span>5K+ bought in past month</span>', '5K+ bought in past month'],
    ['late_dollar_coupon', false, 'coupon', '<span class="s-coupon-unclipped">Save $5 with coupon</span>', 'Save $5 with coupon'],
    ['late_percent_coupon_with_deal', true, 'coupon', '<span class="s-coupon-unclipped">Save 25% with coupon</span>', 'Save 25% with coupon'],
    ['existing_percent_coupon_control', false, 'coupon', '<span class="s-coupon-unclipped">Save 25% with coupon</span>', 'Save 25% with coupon'],
  ] as const) {
    const d = card('', withDeal);
    const cache = new AmazonParseCache();
    const before = pick(parseAmazonSearchResults(d, SEARCH, { cache })[0]);
    d.querySelector('[data-asin]')!.insertAdjacentHTML('beforeend', markup);
    const after = pick(parseAmazonSearchResults(d, SEARCH, { cache })[0]);
    check(name, { before: before?.[field], after: after?.[field] }, { before: null, after: expected });
    check(`${name}_preserves_price_rating`, [after?.price, after?.rating, after?.reviewCount], [before?.price, before?.rating, before?.reviewCount]);
  }
  for (const [name, html, field, expected] of [
    ['recommendation_sales', detail('', '', '<div class="a-carousel-container"><span>10K+ bought in past month</span></div>'), 'pastMonthSales', null],
    ['nested_recommendation_coupon', detail('<div id="apex_desktop"><div class="a-carousel-container"><span class="s-coupon-unclipped">Save 25% with coupon</span></div></div>'), 'coupon', null],
    ['excluded_first_candidate', detail('<span class="couponLabelText">Apply 10% coupon</span>', '<div class="a-carousel-container"><span class="couponLabelText">Save 20% with coupon</span></div>'), 'coupon', 'Apply 10% coupon'],
    ['real_coupon_fragment_without_css', detail(__SAD389_COUPON_FIXTURE__), 'coupon', 'Apply 50% coupon'],
  ] as const) {
    const parsed = pick(parseAmazonProductDetail(doc(html), PDP));
    const offscreen = parsePdpHtml(html, PDP, ASIN);
    check(name, parsed?.[field], expected);
    check(`${name}_offscreen`, offscreen.ok ? pick(offscreen.product)?.[field] : offscreen, expected);
  }
  for (const [name, markup] of [
    ['split_sales', '<div data-cy="reviews-block"><span>1K+</span><span>bought in past month</span></div>'],
    ['paragraph_sales', '<p>1K+ bought in past month</p>'],
  ] as const) {
    check(name, parseAmazonSearchCard(card(markup).querySelector('[data-asin]')!, SEARCH)?.pastMonthSales, '1K+ bought in past month');
  }
  const hidden = card('<span class="s-coupon-unclipped aok-hidden">Save $5 with coupon</span>', true);
  const hiddenCache = new AmazonParseCache();
  check('hidden_initially_missing', parseAmazonSearchResults(hidden, SEARCH, { cache: hiddenCache })[0]?.coupon ?? null, null);
  hidden.querySelector('.s-coupon-unclipped')!.classList.remove('aok-hidden');
  check('attribute_only_cache_reveal', parseAmazonSearchResults(hidden, SEARCH, { cache: hiddenCache })[0]?.coupon, 'Save $5 with coupon');

  let realCardTiming: unknown = null;
  for (const original of document.querySelectorAll('[data-component-type="s-search-result"]')) {
    const clone = original.cloneNode(true) as Element;
    const baseline = parseAmazonSearchCard(clone, SEARCH);
    if (!baseline?.pastMonthSales || !baseline.price || !baseline.imageUrl) continue;
    const leaves = [...clone.querySelectorAll('span')].filter(e => !e.children.length && /bought in past month/i.test(e.textContent ?? ''));
    if (!leaves.length) continue;
    const saved = leaves.map(e => ({ node: e, parent: e.parentNode!, next: e.nextSibling }));
    saved.forEach(x => x.node.remove());
    const cache = new AmazonParseCache();
    const before = pick(cache.getOrParse(clone, e => parseAmazonSearchCard(e, SEARCH)));
    saved.forEach(x => x.parent.insertBefore(x.node, x.next?.parentNode === x.parent ? x.next : null));
    const after = pick(cache.getOrParse(clone, e => parseAmazonSearchCard(e, SEARCH)));
    realCardTiming = { original: pick(baseline), before, after };
    check('real_card_remove_restore', [before?.pastMonthSales, after?.pastMonthSales], [null, baseline.pastMonthSales], 'controlled remove/restore on a clone of a real current-page card');
    break;
  }

  const d = card('<span class="s-coupon-unclipped aok-hidden">Save $5 with coupon</span><p id="proof">Loading monthly data</p><span id="shipping">Arrives tomorrow</span>');
  const pending: MutationRecord[] = [];
  const observer = new MutationObserver(ms => pending.push(...ms));
  observer.observe(d.body, AMAZON_COLLECTION_OBSERVER_OPTIONS);
  for (const [name, change, expected] of [
    ['observer_text_data', () => { d.getElementById('proof')!.firstChild!.nodeValue = '5K+ bought in past month'; }, true],
    ['observer_coupon_class', () => { d.querySelector('.s-coupon-unclipped')!.classList.remove('aok-hidden'); }, true],
    ['observer_noise', () => { d.getElementById('shipping')!.firstChild!.nodeValue = 'Arrives next week'; }, false],
    ['observer_color_noise', () => { d.getElementById('proof')!.setAttribute('style', 'color:red'); }, false],
    ['observer_legacy_insertion', () => { d.querySelector('[data-asin]')!.append(d.createElement('span')); }, true],
  ] as const) {
    pending.length = 0;
    change();
    await new Promise(r => setTimeout(r, 0));
    check(name, pending.some(isRelevantAmazonCollectionMutation), expected, 'native MutationObserver with actual production options/predicate');
  }
  observer.disconnect();
  return {
    engine: 'Moli native DOM; no JSDOM or installed extension', candidateCommit: __SAD389_COMMIT__, capturedAt: new Date().toISOString(), url: location.href,
    live: { title: document.title, products: products.map(pick), salesCount: products.filter(p => p?.pastMonthSales).length, couponCount: products.filter(p => p?.coupon).length },
    realCardTiming, checks, passed: checks.every(c => c.pass),
    limitations: ['Controlled timing is not evidence of naturally occurring Amazon hydration order.', 'Source offers and result sets may change between visits.', 'Chrome service-worker/UI/storage/export are exercised separately.'],
  };
}
(globalThis as any).__SAD389_FIXED_RESULT = run();
