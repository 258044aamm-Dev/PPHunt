/**
 * Step 5.1 (SAD-177) — H-9a: per-card parse memoisation.
 * Proves (1) a second parse of an unchanged document performs ZERO per-card
 * extractions, (2) the risk-R3 guard: incomplete cards (late-hydrating
 * fields) keep being re-parsed until complete, and (3) a 480-card page stays
 * inside a generous JSDOM budget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParseCache } from '@/lib/scraper/parse-cache';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import { extractCardPricingAndDiscounts } from '@/lib/scraper/field-parsers';

vi.mock('@/lib/scraper/field-parsers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/scraper/field-parsers')>();
  return {
    ...actual,
    // called exactly once per NON-cached card in both parsers — the perfect
    // probe for "did we re-extract this card?"
    extractCardPricingAndDiscounts: vi.fn(actual.extractCardPricingAndDiscounts),
  };
});

const pricingSpy = vi.mocked(extractCardPricingAndDiscounts);

const URL = 'https://www.amazon.com/s?k=perf';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** A COMPLETE search card: every hydrating field present → cacheable. */
function searchCard(asin: string, opts: { noImage?: boolean } = {}): string {
  return `
    <div data-component-type="s-search-result" data-asin="${asin}">
      <div data-cy="title-recipe">
        <h2><a class="a-link-normal" href="/Product-${asin}/dp/${asin}"><span>Product ${asin}</span></a></h2>
      </div>
      <div data-cy="price-recipe">
        <span class="a-price"><span class="a-price-symbol">$</span><span class="a-price-whole">39</span><span class="a-price-fraction">99</span></span>
      </div>
      <div data-cy="reviews-block">
        <span class="a-icon-alt">4.5 out of 5 stars</span>
        <a href="/dp/${asin}#customerReviews"><span class="s-underline-text">(1,234)</span></a>
      </div>
      <span class="zg-bdg-text">#5</span>
      ${opts.noImage ? '' : `<img class="s-image" src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" />`}
    </div>`;
}

beforeEach(() => {
  pricingSpy.mockClear();
});

describe('H-9a: O(1) re-parse of an unchanged document', () => {
  it('extracts every card on the first pass and ZERO on the second', () => {
    const doc = createDoc(
      ['B0PERF0001', 'B0PERF0002', 'B0PERF0003', 'B0PERF0004', 'B0PERF0005']
        .map((a) => searchCard(a))
        .join('')
    );
    const cache = new ParseCache();

    const first = parseSearchResults(doc, URL, cache);
    expect(first).toHaveLength(5);
    expect(pricingSpy).toHaveBeenCalledTimes(5);

    pricingSpy.mockClear();
    const second = parseSearchResults(doc, URL, cache);
    expect(second).toHaveLength(5); // same results, same order
    expect(second.map((p) => p.asin)).toEqual(first.map((p) => p.asin));
    expect(pricingSpy).toHaveBeenCalledTimes(0); // the fix: zero re-extraction

    // without the cache the work happens again — proves the cache is the cause
    const uncached = parseSearchResults(doc, URL);
    expect(uncached).toHaveLength(5);
    expect(pricingSpy).toHaveBeenCalledTimes(5);
  });

  it('category parser memoises too', () => {
    // bestsellers-style cards (the category parser's native markup)
    const catCard = (asin: string) => `
      <div id="gridItemRoot" class="zg-grid-general-faceout" data-asin="${asin}">
        <span class="zg-bdg-text">#1</span>
        <a href="/Product-${asin}/dp/${asin}">
          <div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Product ${asin}</div>
        </a>
        <span class="a-price"><span class="a-offscreen">$79.99</span></span>
        <span class="a-icon-alt">4.5 out of 5 stars</span>
        <a href="/dp/${asin}#customerReviews"><span class="a-size-small">1,234</span></a>
        <img src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" />
      </div>`;
    const doc = createDoc(
      ['B0CAT00001', 'B0CAT00002', 'B0CAT00003'].map(catCard).join('')
    );
    const cache = new ParseCache();

    const first = parseCategoryPage(
      doc,
      'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics',
      'category',
      cache
    );
    const firstCalls = pricingSpy.mock.calls.length;
    expect(first.length).toBeGreaterThan(0);

    pricingSpy.mockClear();
    const second = parseCategoryPage(
      doc,
      'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics',
      'category',
      cache
    );
    expect(second.map((p) => p.asin)).toEqual(first.map((p) => p.asin));
    expect(pricingSpy).toHaveBeenCalledTimes(0);
    expect(firstCalls).toBeGreaterThan(0);
  });

  it('first-card-wins ordering survives caching (duplicate ASINs)', () => {
    const doc = createDoc(
      [
        searchCard('B0DUP00001').replace('Product B0DUP00001', 'First Copy'),
        searchCard('B0OTHER001'),
        searchCard('B0DUP00001').replace('Product B0DUP00001', 'Second Copy'),
      ].join('')
    );
    const cache = new ParseCache();

    const first = parseSearchResults(doc, URL, cache);
    expect(first).toHaveLength(2);
    expect(first[0]!.title).toBe('First Copy');

    pricingSpy.mockClear();
    const second = parseSearchResults(doc, URL, cache);
    expect(second).toHaveLength(2);
    expect(second[0]!.title).toBe('First Copy'); // dedup order unchanged
    expect(pricingSpy).toHaveBeenCalledTimes(0);
  });
});

describe('H-9a: risk R3 — late-hydrating fields keep re-parsing', () => {
  it('an incomplete card (missing image) is re-parsed and enriched once the DOM hydrates', () => {
    const doc = createDoc(searchCard('B0LATE0001', { noImage: true }));
    const cache = new ParseCache();

    const first = parseSearchResults(doc, URL, cache);
    expect(first).toHaveLength(1);
    expect(first[0]!.imageUrl).toBeFalsy(); // image not in the DOM yet

    // Amazon hydrates the image a tick later
    const cardEl = doc.querySelector('[data-asin="B0LATE0001"]')!;
    const img = doc.createElement('img');
    img.className = 's-image';
    img.src = 'https://m.media-amazon.com/images/I/late._AC_UL320_.jpg';
    cardEl.appendChild(img);

    const second = parseSearchResults(doc, URL, cache);
    expect(pricingSpy.mock.calls.length).toBeGreaterThan(0); // re-parsed, NOT served from cache
    expect(second[0]!.imageUrl).toContain('late._AC_UL320_.jpg'); // enrichment preserved

    // now complete → third pass is memoised
    pricingSpy.mockClear();
    const third = parseSearchResults(doc, URL, cache);
    expect(third[0]!.imageUrl).toContain('late._AC_UL320_.jpg');
    expect(pricingSpy).toHaveBeenCalledTimes(0);
  });
});

describe('H-9a: parse budget on a large page', () => {
  it(
    'parses a 480-card fixture well under budget, then re-parses ~for free',
    () => {
      const asins = Array.from(
        { length: 480 },
        (_, i) => `B0BIG${String(i).padStart(5, '0')}`
      );
      const doc = createDoc(asins.map((a) => searchCard(a)).join(''));
      const cache = new ParseCache();

      const t0 = performance.now();
      const first = parseSearchResults(doc, URL, cache);
      const coldMs = performance.now() - t0;
      expect(first).toHaveLength(480);
      // JSDOM upper bound; native DOM is several times faster (plan Step 5.1)
      expect(coldMs).toBeLessThan(4000);

      const t1 = performance.now();
      const second = parseSearchResults(doc, URL, cache);
      const warmMs = performance.now() - t1;
      expect(second).toHaveLength(480);
      expect(warmMs).toBeLessThan(coldMs / 4); // memoised pass is dramatically cheaper
    },
    30_000
  );
});

/**
 * Step 5.2 (SAD-178) — H-9b: linear nested-card filtering.
 * The strongest available no-regression proof: the new Set/ancestor-walk
 * implementation must return EXACTLY the same elements, in the same order, as
 * the original O(N²) `Node.contains()` filters on a generated fixture.
 */
import {
  dropNestedCards,
  isWithinAnyCard,
  containsAnyCard,
} from '@/lib/scraper/field-parsers';

describe('H-9b: dropNestedCards equivalence with the O(N²) original', () => {
  function nestedFixture(): { doc: Document; cards: Element[] } {
    const doc = createDoc(`
      <div id="root">
        <div class="card" id="c1">
          <div class="card" id="c2">nested inside c1</div>
        </div>
        <div class="card" id="c3"></div>
        <div id="c4">
          <div class="card" id="c5"></div>
          <span class="card" id="c6">deep under c4, sibling of c5</span>
        </div>
      </div>`);
    const byId = (id: string) => doc.getElementById(id)!;
    // Mixed order incl. a nested card BEFORE its ancestor and duplicate refs
    return {
      doc,
      cards: [byId('c2'), byId('c1'), byId('c3'), byId('c5'), byId('c3'), byId('c6')],
    };
  }

  it('identity variant matches the original cards.some(contains) filter', () => {
    const { cards } = nestedFixture();
    // Original category-page.ts implementation, verbatim:
    const reference = cards.filter(
      (card) => !cards.some((other) => other !== card && other.contains(card))
    );
    expect(dropNestedCards(cards)).toEqual(reference);
    // sanity: c2 (nested in c1) dropped, duplicates of c3 both kept
    expect(reference.map((e) => e.id)).toEqual(['c1', 'c3', 'c5', 'c3', 'c6']);
  });

  it('dropDuplicates variant matches the index-based filter of discoverFallbackProductCards', () => {
    const { cards } = nestedFixture();
    // Original field-parsers.ts implementation, verbatim:
    const reference = cards.filter(
      (card, idx) =>
        !cards.some((other, otherIdx) => otherIdx !== idx && other.contains(card))
    );
    expect(dropNestedCards(cards, { dropDuplicates: true })).toEqual(reference);
    // sanity: the duplicated c3 drops BOTH copies here
    expect(reference.map((e) => e.id)).toEqual(['c1', 'c5', 'c6']);
  });

  it('isWithinAnyCard matches cards.some((c) => c.contains(el))', () => {
    const { doc, cards } = nestedFixture();
    const set = new Set(cards);
    const targets = [
      doc.getElementById('c2')!,
      doc.getElementById('c3')!,
      doc.getElementById('c4')!,
      doc.getElementById('root')!,
      doc.querySelector('#c5 span') ?? doc.getElementById('c5')!,
    ];
    for (const t of targets) {
      expect(isWithinAnyCard(t, set)).toBe(
        cards.some((existing) => existing.contains(t))
      );
    }
  });

  it('containsAnyCard matches cards.some((c) => root.contains(c))', () => {
    const { doc, cards } = nestedFixture();
    const set = new Set(cards);
    const roots = [
      doc.getElementById('c1')!,
      doc.getElementById('c4')!,
      doc.getElementById('root')!,
      doc.getElementById('c3')!,
    ];
    for (const r of roots) {
      // original checked strict containment OR identity via ===
      expect(containsAnyCard(r, set) || set.has(r)).toBe(
        cards.some((existing) => r.contains(existing))
      );
    }
  });

  it('480-card category fixture parses inside budget with the linear filter', () => {
    const catCard = (asin: string) => `
      <div id="gridItemRoot" class="zg-grid-general-faceout" data-asin="${asin}">
        <span class="zg-bdg-text">#1</span>
        <a href="/Product-${asin}/dp/${asin}">
          <div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Product ${asin}</div>
        </a>
        <span class="a-price"><span class="a-offscreen">$79.99</span></span>
        <span class="a-icon-alt">4.5 out of 5 stars</span>
        <a href="/dp/${asin}#customerReviews"><span class="a-size-small">1,234</span></a>
        <img src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" />
      </div>`;
    const asins = Array.from(
      { length: 480 },
      (_, i) => `B0CBIG${String(i).padStart(4, '0')}`
    );
    const doc = createDoc(asins.map(catCard).join(''));

    const t0 = performance.now();
    const parsed = parseCategoryPage(
      doc,
      'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics'
    );
    const ms = performance.now() - t0;
    expect(parsed).toHaveLength(480);
    expect(ms).toBeLessThan(6000); // JSDOM upper bound; the O(N²) path was the risk
  }, 30_000);
});
