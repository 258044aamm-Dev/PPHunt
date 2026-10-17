/**
 * Step 5.3 (SAD-179) — M-2: countProducts must count real product cards.
 * Proves (1) carousel/footer /dp/ links no longer inflate the counter,
 * (2) the under-count guard: for every page type the counter is >= what the
 * corresponding parser extracts, and (3) the reproducing end-to-end case:
 * with peripheral /dp/ links growing every tick, automatic mode now reaches
 * onEndOfPage within maxStale+margin ticks and never fires pointless
 * onNewProducts — while the OLD broad counter keeps getting reset forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countProductCards } from '@/lib/scraper/count-products';
import { SELECTORS } from '@/lib/scraper/selectors';
import { ScrollController } from '@/lib/scraper/scroll-controller';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { parseCategoryPage } from '@/lib/scraper/category-page';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** The OLD (pre-5.3) broad union, kept as the control implementation. */
function oldBroadCount(document: Document): number {
  return document.querySelectorAll(
    `${SELECTORS.search.productCard}, ${SELECTORS.category.productCard}, [data-asin]:not([data-asin=""]), a[href*="/dp/"]`
  ).length;
}

const searchCard = (asin: string) => `
  <div data-component-type="s-search-result" data-asin="${asin}">
    <h2><a class="a-link-normal" href="/Product-${asin}/dp/${asin}"><span>Product ${asin}</span></a></h2>
    <span class="a-price"><span class="a-price-symbol">$</span><span class="a-price-whole">39</span><span class="a-price-fraction">99</span></span>
    <img class="s-image" src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" />
  </div>`;

const catCard = (asin: string) => `
  <div id="gridItemRoot" class="zg-grid-general-faceout" data-asin="${asin}">
    <a href="/Product-${asin}/dp/${asin}">
      <div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Product ${asin}</div>
    </a>
    <span class="a-price"><span class="a-offscreen">$79.99</span></span>
    <img src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" />
  </div>`;

const dealCard = (asin: string) => `
  <div data-testid="deal-card" data-asin="${asin}">
    <a href="/deal-${asin}/dp/${asin}"><div data-testid="deal-title">Deal ${asin}</div></a>
    <span class="a-price"><span class="a-offscreen">$19.99</span></span>
    <img src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" />
  </div>`;

/** Recommendation-carousel / "customers also bought" / footer noise. */
function carouselNoise(n: number, offset = 0): string {
  return Array.from(
    { length: n },
    (_, i) =>
      `<div class="a-carousel-card"><a href="/Rec-${i}/dp/B0CAROUSEL${String(
        offset + i
      ).padStart(2, '0')}"><img src="https://m.media-amazon.com/images/I/x.jpg"/></a></div>`
  ).join('');
}

describe('M-2: countProductCards counts real product cards only', () => {
  it('10 real cards + 40 carousel links → counts 10 (old union counted 50)', () => {
    const asins = Array.from(
      { length: 10 },
      (_, i) => `B0CNT${String(i).padStart(5, '0')}`
    );
    const doc = createDoc(
      `<div id="results">${asins.map(searchCard).join('')}</div>
       <div class="recommendations">${carouselNoise(40)}</div>`
    );

    expect(countProductCards(doc)).toBe(10);
    // the failure mode being removed:
    expect(oldBroadCount(doc)).toBeGreaterThanOrEqual(50);
  });

  it('under-count guard: counter >= parser output for search pages', () => {
    const asins = Array.from(
      { length: 8 },
      (_, i) => `B0SRCH${String(i).padStart(4, '0')}`
    );
    const doc = createDoc(
      `<div id="results">${asins.map(searchCard).join('')}</div>${carouselNoise(12)}`
    );
    const parsed = parseSearchResults(doc, 'https://www.amazon.com/s?k=x');
    expect(parsed.length).toBeGreaterThan(0);
    expect(countProductCards(doc)).toBeGreaterThanOrEqual(parsed.length);
  });

  it('under-count guard: counter >= parser output for category/bestsellers pages', () => {
    const asins = Array.from(
      { length: 8 },
      (_, i) => `B0CATC${String(i).padStart(4, '0')}`
    );
    const doc = createDoc(asins.map(catCard).join('') + carouselNoise(12));
    const parsed = parseCategoryPage(
      doc,
      'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics'
    );
    expect(parsed.length).toBeGreaterThan(0);
    expect(countProductCards(doc)).toBeGreaterThanOrEqual(parsed.length);
  });

  it('under-count guard: counter >= parser output for deals pages', () => {
    const asins = Array.from(
      { length: 6 },
      (_, i) => `B0DEAL${String(i).padStart(4, '0')}`
    );
    const doc = createDoc(asins.map(dealCard).join('') + carouselNoise(12));
    const parsed = parseCategoryPage(
      doc,
      'https://www.amazon.com/deals',
      'category'
    );
    expect(parsed.length).toBeGreaterThan(0);
    expect(countProductCards(doc)).toBeGreaterThanOrEqual(parsed.length);
  });
});

describe('M-2: end-of-page detection survives peripheral lazy-loading', () => {
  let controller: ScrollController | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
  });
  afterEach(() => {
    controller?.stop();
    controller = null;
    vi.useRealTimers();
  });

  /** Run the controller while the test keeps appending carousel links. */
  function runWithCarouselGrowth(
    countFn: (doc: Document) => number,
    doc: Document,
    totalMs: number
  ): { newProductCalls: number; endOfPageCalls: number; ticks: number } {
    const onNewProducts = vi.fn();
    const onEndOfPage = vi.fn();
    let ticks = 0;

    // peripheral content lazy-loads forever (5 new /dp/ links every 100 ms)
    const noise = window.setInterval(() => {
      const shelf = doc.createElement('div');
      shelf.innerHTML = carouselNoise(5, Math.floor(Math.random() * 100000));
      doc.body.appendChild(shelf);
    }, 100);

    controller = new ScrollController();
    controller.start(
      onNewProducts,
      onEndOfPage,
      () => true,
      () => {
        ticks++;
        return countFn(doc);
      },
      () => false
    );

    vi.advanceTimersByTime(totalMs);
    window.clearInterval(noise);
    return {
      newProductCalls: onNewProducts.mock.calls.length,
      endOfPageCalls: onEndOfPage.mock.calls.length,
      ticks,
    };
  }

  it('narrowed counter: no wasted onNewProducts, onEndOfPage within maxStale+margin ticks', () => {
    const asins = Array.from(
      { length: 10 },
      (_, i) => `B0EOP${String(i).padStart(5, '0')}`
    );
    const doc = createDoc(asins.map(searchCard).join(''));

    // default config: maxStale = ceil(5000/500) = 10 ticks; each tick waits
    // waitAfterScroll (1500) before counting, so ~25 s covers 10 ticks + margin
    const result = runWithCarouselGrowth(countProductCards, doc, 25_000);

    expect(result.newProductCalls).toBe(0); // carousels no longer trigger parses
    expect(result.endOfPageCalls).toBe(1); // and the exit fires
    expect(result.ticks).toBeLessThanOrEqual(10 + 4); // maxStale + margin
  });

  it('control: the OLD broad counter is kept alive by carousel churn', () => {
    const asins = Array.from(
      { length: 10 },
      (_, i) => `B0EOP${String(i).padStart(5, '0')}`
    );
    const doc = createDoc(asins.map(searchCard).join(''));

    const result = runWithCarouselGrowth(oldBroadCount, doc, 25_000);

    // every tick sees growth → staleCount never reaches maxStale in this window
    expect(result.newProductCalls).toBeGreaterThan(0);
    expect(result.endOfPageCalls).toBe(0);
  });
});
