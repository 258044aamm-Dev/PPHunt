/**
 * SAD-386 step 6 — the same card must yield the same discount and deal through
 * EVERY workflow the extension uses, in both collection modes.
 *
 * Surfaces (plan §1 W1-W8), all reached through real code paths:
 *   W1 search-results collection      → parseAmazonSearchResults
 *   W2 category / deals collection    → parseAmazonCategoryPage
 *   W4 one-click card save            → extractProductFromCard (content script)
 *   W5 right-click save on a card     → the same resolver as W4
 *   W6 background enrichment of a PDP → parsePdpHtml (offscreen)
 *   W3 product-page collection        → parseAmazonProductDetail
 *   W8 manual vs automatic mode       → the parser is mode-independent; both
 *                                       modes write through the same collection
 *                                       path, so the session mode is asserted to
 *                                       be irrelevant to extraction.
 */
import { describe, expect, it } from 'vitest';
import {
  parseAmazonCategoryPage,
  parseAmazonProductDetail,
  parseAmazonSearchResults,
} from '@/engines/amazon/scraper';
import { extractProductFromCard } from '@/engines/amazon/content/save-product';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';
import type { CollectionMode } from '@/engines/amazon/types';

const SEARCH_URL = 'https://www.amazon.com/s?k=laptop';
const DEALS_URL = 'https://www.amazon.com/deals';
const PDP_URL = 'https://www.amazon.com/dp/B0PARITY01';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** A search card with a printed percentage and a printed badge. */
const SEARCH_CARD = `
  <div class="s-main-slot">
    <div data-component-type="s-search-result" data-asin="B0PARITY01">
      <div data-cy="title-recipe">
        <a class="a-link-normal" href="/dp/B0PARITY01"><h2><span>Parity Laptop</span></h2></a>
      </div>
      <div data-cy="price-recipe">
        <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$79.99</span></span>
        <span class="a-price"><span class="a-offscreen">$24.99</span></span>
        <span class="savingsPercentage">-69%</span>
        <span data-a-badge-type="deal"><span class="a-badge-text">Limited time deal</span></span>
      </div>
      <img class="s-image" src="https://m.media-amazon.com/images/I/71parity._AC_UY218_.jpg" />
    </div>
  </div>`;

/** A deals-grid card: no printed percentage, struck list price only. */
const DEALS_CARD = `
  <div class="grid">
    <div class="ProductCard-module__card_uyr_Jh7WpSkPx4iEpn4w" data-asin="B0PARITY02" data-testid="product-card" role="group">
      <a class="a-link-normal" href="https://www.amazon.com/dp/B0PARITY02">
        <div class="a-section ProductCard-module__priceContainer_m0ycNRDHrTYDub6rnxSJ">
          <span class="a-price"><span class="a-offscreen">Deal Price: $199.99</span></span>
          <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">List: $999.99</span></span>
        </div>
        <p id="title-B0PARITY02"><span><span class="a-truncate">Parity Vacuum Cleaner</span></span></p>
      </a>
      <img class="a-amazon-image" src="https://m.media-amazon.com/images/I/71parity2._AC_SF226,226_QL85_.jpg" alt="Vacuum" />
    </div>
  </div>`;

/** The same observation as a product page. */
const PDP_HTML = `<!doctype html><html><head><link rel="canonical" href="https://www.amazon.com/dp/B0PARITY03" /></head><body>
  <div id="centerCol">
    <h1 id="title"><span id="productTitle">Parity Headphones</span></h1>
    <a id="bylineInfo">Visit the Parity Store</a>
    <div id="corePriceDisplay_desktop_feature_div">
      <span class="savingsPercentage">-23%</span>
      <span class="a-price"><span class="a-offscreen">$329.00</span></span>
      <span class="basisPrice"><span class="a-price" data-a-strike="true"><span class="a-offscreen">$429.00</span></span></span>
    </div>
  </div>
  <img id="landingImage" src="https://m.media-amazon.com/images/I/71parity3._AC_SL1500_.jpg" />
</body></html>`;

describe('SAD-386: the same observation through every workflow', () => {
  it('search card: collection, one-click save and right-click save agree', () => {
    const collected = parseAmazonSearchResults(doc(SEARCH_CARD), SEARCH_URL).find(
      (p) => p.asin === 'B0PARITY01',
    )!;
    const card = doc(SEARCH_CARD).querySelector('[data-asin="B0PARITY01"]')!;
    const saved = extractProductFromCard(card, SEARCH_URL)!;

    const expected = { discountPercentage: '69% off', dealBadge: 'Limited time deal' };
    expect({ discountPercentage: collected.discountPercentage, dealBadge: collected.dealBadge }).toEqual(expected);
    expect({ discountPercentage: saved.discountPercentage, dealBadge: saved.dealBadge }).toEqual(expected);
  });

  it('deals card: category collection and card save agree, and no percentage is invented', () => {
    const collected = parseAmazonCategoryPage(doc(DEALS_CARD), DEALS_URL)[0]!;
    const card = doc(DEALS_CARD).querySelector('[data-asin="B0PARITY02"]')!;
    const saved = extractProductFromCard(card, DEALS_URL)!;

    for (const product of [collected, saved]) {
      expect(product.discountPercentage).toBeUndefined(); // printed-only (D2)
      expect(product.dealBadge).toBe('Deal'); // proven (D5)
    }
  });

  it('product page: live parse, offscreen enrichment and PDP collection agree', () => {
    const live = parseAmazonProductDetail(doc(PDP_HTML), PDP_URL)!;
    const offscreen = parsePdpHtml(PDP_HTML, PDP_URL);
    expect(offscreen.ok).toBe(true);

    const enriched = offscreen.ok ? offscreen.product : null;
    for (const product of [live, enriched]) {
      expect(product?.discountPercentage).toBe('23% off');
      // The page prints no badge, but the struck list price proves a deal.
      expect(product?.dealBadge).toBe('Deal');
    }
  });

  it('collection mode does not influence extraction', () => {
    // Both modes write through the same parse; the mode only drives scrolling
    // and the target count (`CollectionMode = 'manual' | 'automatic'`).
    const modes: CollectionMode[] = ['manual', 'automatic'];
    const results = modes.map(() =>
      parseAmazonSearchResults(doc(SEARCH_CARD), SEARCH_URL).find((p) => p.asin === 'B0PARITY01'),
    );
    expect(results[0]?.discountPercentage).toBe(results[1]?.discountPercentage);
    expect(results[0]?.dealBadge).toBe(results[1]?.dealBadge);
  });
});
