/**
 * SAD-386 step 2 — card-level discount and deal discovery.
 *
 * The eight card shapes below are the probe matrix from the plan (§5 F3, probe
 * P02), replayed against the real parsers. A and E are the shapes that already
 * worked: their output is asserted **byte-identical** to before the change.
 * B/H are discount fixes, C/D are deal fixes, F/G pin the two decisions (no
 * computed percentage from a struck price unless D5, no coupon as a discount).
 */
import { describe, expect, it } from 'vitest';
import {
  extractCardPricingAndDiscounts,
  parseAmazonCategoryPage,
  parseAmazonProductDetail,
  parseAmazonSearchResults,
} from '@/engines/amazon/scraper';
import { DERIVED_DEAL_LABEL } from '@/engines/amazon/scraper/deal-evidence';

const SEARCH_URL = 'https://www.amazon.com/s?k=laptop';
const DEALS_URL = 'https://www.amazon.com/deals';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function cardOf(html: string): Element {
  return doc(html).querySelector('[data-component-type="s-search-result"]')!;
}

/** A card with a price and nothing else — the base every shape starts from. */
function card(asin: string, inner: string): string {
  return `
    <div class="s-main-slot">
      <div data-component-type="s-search-result" data-asin="${asin}">
        <div data-cy="title-recipe">
          <a class="a-link-normal" href="/dp/${asin}"><h2><span>Product ${asin}</span></h2></a>
        </div>
        <div data-cy="price-recipe">
          <span class="a-price" data-a-color="base"><span class="a-offscreen">$31.99</span></span>
          ${inner}
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/71img._AC_UY218_.jpg" />
      </div>
    </div>`;
}

describe('SAD-386: card discount and deal discovery', () => {
  it('A — the classic savings percentage + deal attribute badge is unchanged', () => {
    const pricing = extractCardPricingAndDiscounts(
      cardOf(
        card(
          'B0AAA00001',
          `<span class="savingsPercentage">-68%</span>
           <span data-a-badge-type="deal"><span class="a-badge-text">Limited time deal</span></span>`,
        ),
      ),
      SEARCH_URL,
    );
    expect(pricing.price).toBe(31.99);
    expect(pricing.discountPercentage).toBe('68% off');
    expect(pricing.dealBadge).toBe('Limited time deal');
    expect(pricing.dealBadgeDerived).toBeUndefined();
  });

  it('B — a percentage printed with a typographic minus is now read', () => {
    const pricing = extractCardPricingAndDiscounts(
      cardOf(
        card(
          'B0BBB00001',
          `<span class="a-letter-space"></span><span class="a-size-base a-color-price">(\u221268%)</span>`,
        ),
      ),
      SEARCH_URL,
    );
    expect(pricing.discountPercentage).toBe('68% off');
  });

  it('C — a badge in the status-badge slot is now read as the deal', () => {
    const pricing = extractCardPricingAndDiscounts(
      cardOf(
        card(
          'B0CCC00001',
          `<span data-component-type="s-status-badge-component"><span class="a-badge-text">Limited time deal</span></span>`,
        ),
      ),
      SEARCH_URL,
    );
    expect(pricing.dealBadge).toBe('Limited time deal');
  });

  it('D — the bare [data-a-badge-type="deal"] node (attribute on the text) is now read', () => {
    const pricing = extractCardPricingAndDiscounts(
      cardOf(card('B0DDD00001', `<span data-a-badge-type="deal">Limited time deal</span>`)),
      SEARCH_URL,
    );
    expect(pricing.dealBadge).toBe('Limited time deal');
  });

  it('E — the module-CSS badge and discount text are unchanged', () => {
    const pricing = extractCardPricingAndDiscounts(
      cardOf(
        card(
          'B0EEE00001',
          `<div class="_c2Itd_dealBadge_KEp1h" data-deal-badge-automated="true"><span>Limited time deal</span></div>
           <span class="_c2Itd_discountText_2gdxP">-38%</span>`,
        ),
      ),
      SEARCH_URL,
    );
    expect(pricing.discountPercentage).toBe('38% off');
    expect(pricing.dealBadge).toBe('Limited time deal');
  });

  it('F — a struck list price alone still stores NO discount (D2) but proves a deal (D5)', () => {
    const pricing = extractCardPricingAndDiscounts(
      cardOf(
        card(
          'B0FFF00001',
          `<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$99.99</span></span>`,
        ),
      ),
      SEARCH_URL,
    );
    expect(pricing.listPrice).toBe(99.99);
    expect(pricing.discountPercentage).toBeUndefined(); // printed-only decision
    expect(pricing.dealBadge).toBe(DERIVED_DEAL_LABEL); // strike-price decision
    expect(pricing.dealBadgeDerived).toBe(true);
  });

  it('G — a coupon percentage is never stored as the product discount', () => {
    const html = `
      <div class="s-main-slot">
        <div data-component-type="s-search-result" data-asin="B0GGG00001">
          <div data-cy="title-recipe">
            <a class="a-link-normal" href="/dp/B0GGG00001"><h2><span>Coupon Product</span></h2></a>
          </div>
          <div data-cy="price-recipe">
            <span class="a-price" data-a-color="base"><span class="a-offscreen">$31.99</span></span>
            <span class="s-coupon-unclipped">Save 15% off with coupon</span>
          </div>
          <img class="s-image" src="https://m.media-amazon.com/images/I/71img._AC_UY218_.jpg" />
        </div>
      </div>`;
    const products = parseAmazonSearchResults(doc(html), SEARCH_URL);
    const product = products[0]!;
    expect(product.discountPercentage).toBeUndefined();
    expect(product.coupon).toBe('Save 15% off with coupon'); // still a coupon
    expect(product.dealBadge).toBeUndefined();
  });

  it('H — a percentage wrapped in markup is now read', () => {
    const pricing = extractCardPricingAndDiscounts(
      cardOf(card('B0HHH00001', `<span class="a-letter-space"></span><span><b>-68%</b><i></i></span>`)),
      SEARCH_URL,
    );
    expect(pricing.discountPercentage).toBe('68% off');
  });

  it('never reads a deal badge from a title, a delivery line or a status badge', () => {
    const html = `
      <div class="s-main-slot">
        <div data-component-type="s-search-result" data-asin="B0NEG00001">
          <div data-cy="title-recipe">
            <a class="a-link-normal" href="/dp/B0NEG00001"><h2><span>Deal Dash Board Game Deluxe Edition</span></h2></a>
          </div>
          <span data-component-type="s-status-badge-component"><span class="a-badge-text">Amazon's Choice</span></span>
          <div data-cy="delivery-recipe"><span aria-label="FREE delivery Tomorrow">FREE delivery Tomorrow</span></div>
          <div data-cy="price-recipe">
            <span class="a-price" data-a-color="base"><span class="a-offscreen">$14.99</span></span>
          </div>
          <img class="s-image" src="https://m.media-amazon.com/images/I/71img._AC_UY218_.jpg" />
        </div>
      </div>`;
    const product = parseAmazonSearchResults(doc(html), SEARCH_URL)[0]!;
    expect(product.dealBadge).toBeUndefined();
    expect(product.badge).toBe("Amazon's Choice");
    expect(product.discountPercentage).toBeUndefined();
  });

  it('a printed badge always outranks a derived one on a product page', () => {
    // Regression: with a struck list price present the derivation ran first and
    // the PDP reported "Deal" instead of the badge the page actually printed.
    const html = `<html><head><link rel="canonical" href="https://www.amazon.com/dp/B0TEST0002" /></head><body>
      <div id="centerCol">
        <h1 id="title"><span id="productTitle">Test Headphones</span></h1>
        <div id="dealBadge_feature_div"><span class="dealBadgeText">Limited-time deal</span></div>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="savingsPercentage">-23%</span>
          <span class="a-price"><span class="a-offscreen">$329.00</span></span>
          <span class="basisPrice"><span class="a-price" data-a-strike="true"><span class="a-offscreen">$429.00</span></span></span>
        </div>
      </div></body></html>`;
    const product = parseAmazonProductDetail(doc(html), 'https://www.amazon.com/dp/B0TEST0002');
    expect(product?.dealBadge).toBe('Limited-time deal');
    expect(product?.discountPercentage).toBe('23% off');
  });

  it('a product page with only a struck list price reports the derived deal (D5)', () => {
    const html = `<html><head><link rel="canonical" href="https://www.amazon.com/dp/B0TEST0003" /></head><body>
      <div id="centerCol">
        <h1 id="title"><span id="productTitle">Silent Sale Headphones</span></h1>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">$329.00</span></span>
          <span class="basisPrice"><span class="a-price" data-a-strike="true"><span class="a-offscreen">$429.00</span></span></span>
        </div>
      </div></body></html>`;
    const product = parseAmazonProductDetail(doc(html), 'https://www.amazon.com/dp/B0TEST0003');
    expect(product?.dealBadge).toBe(DERIVED_DEAL_LABEL);
    expect(product?.discountPercentage).toBeUndefined(); // printed-only (D2)
  });

  it('the /deals card the repo captured verbatim now reports a deal', () => {
    // Real markup, captured from a hydrated amazon.com/deals page (SAD-351).
    const html = `
      <div class="grid">
        <div class="ProductCard-module__card_uyr_Jh7WpSkPx4iEpn4w" data-asin="B0FB59FN5M" data-testid="product-card" role="group">
          <a class="a-link-normal" href="https://www.amazon.com/dp/B0FB59FN5M?ref=dlx_deals_dg_dcl">
            <div class="a-section a-spacing-mini ProductCard-module__priceContainer_m0ycNRDHrTYDub6rnxSJ">
              <span class="a-price"><span class="a-offscreen">Deal Price: $199.99</span></span>
              <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">List: $999.99</span></span>
            </div>
            <p class="a-spacing-none" id="title-B0FB59FN5M"><span><span class="a-truncate">Shark PowerPro Reveal Plus Cordless Vacuum Cleaner</span></span></p>
          </a>
          <img class="a-amazon-image" src="https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg" alt="Shark" />
        </div>
      </div>`;
    const [product] = parseAmazonCategoryPage(doc(html), DEALS_URL);
    expect(product!.price).toBe(199.99);
    expect(product!.listPrice).toBe(999.99);
    expect(product!.discountPercentage).toBeUndefined(); // Amazon printed no percentage
    // The card prints "Deal Price:", and its list price is struck (D5) — so the
    // deal is real even though there is no badge node.
    expect(product!.dealBadge).toBe(DERIVED_DEAL_LABEL);
  });
});
