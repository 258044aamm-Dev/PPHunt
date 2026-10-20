/**
 * SAD-360 (steps 2-3): shared Temu parser fixtures.
 *
 * Kept separate from the test files so the same HTML can be replayed against
 * the pre-instrumentation build during the before/after non-regression check.
 */

export interface TemuPdpFixture {
  name: string;
  url: string;
  html: string;
}

export const PDP_URL =
  'https://www.temu.com/wireless-earbuds-g-601099769178067.html';

function page(body: string): string {
  return `<!doctype html><html><head></head><body>${body}</body></html>`;
}

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

const FULL_JSON_LD = {
  '@type': 'Product',
  sku: '601099769178067',
  name: 'Wireless Bluetooth Earbuds with Charging Case',
  description: 'Noise cancelling earbuds with 30 hour battery life.',
  image: ['https://img.kwcdn.com/product/fancy/earbuds-2.jpg'],
  brand: { name: 'Anker' },
  aggregateRating: { ratingValue: '4.7', reviewCount: '1245' },
  offers: {
    price: '12.49',
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
    seller: { name: 'AnkerDirect' },
  },
};

/** Every supported PDP field is present. */
export const FULL_PDP = page(`
  <div id="goodsDetail">
    <ul>
      <li>Bluetooth 5.3 with low-latency pairing</li>
      <li>30 hour battery life with the charging case</li>
    </ul>
  </div>
  <div id="leftContent">
    <img data-js-main-img="true" src="https://img.kwcdn.com/product/fancy/earbuds.jpg" alt="item picture Wireless Earbuds" />
  </div>
  <div id="rightContent">
    <h1 aria-label="Wireless Bluetooth Earbuds with Charging Case">Wireless Bluetooth Earbuds</h1>
    <div id="goods_price">
      <span data-type="price"><span class="srOnly">US$12.49</span><span>$12</span><span>.49</span></span>
      <span data-type="priceText">US$29.99</span>
      <span data-type="discount">-58%</span>
    </div>
    <div id="reviewContent">
      <div role="img" aria-label="4.7 out of five stars"></div>
      <span aria-label="1,245 reviews">(1,245)</span>
    </div>
    <div data-type="saleTips">10K+ sold</div>
    <span>Free shipping</span>
    <span>Brand: Anker</span>
    <span>Sold by AnkerDirect</span>
    <span>Local warehouse</span>
    <span>Lightning deal</span>
    <span>Save $2 with coupon</span>
    <span>Only 3 left</span>
    <span>#1 Best Seller in Earbuds</span>
    <span>Sponsored</span>
  </div>
  ${jsonLd(FULL_JSON_LD)}
`);

/** Only a title and a price exist; everything else is genuinely absent. */
export const MINIMAL_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Plain Cotton T-Shirt">Plain Cotton T-Shirt</h1>
    <div id="goods_price">
      <span data-type="price"><span class="srOnly">US$7.99</span></span>
    </div>
  </div>
`);

/** A price node exists but its text cannot be parsed. */
export const PRICE_UNPARSEABLE_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Call For Price Item">Call For Price Item</h1>
    <div id="goods_price">
      <span data-type="price">Request a price</span>
    </div>
  </div>
`);

/** No usable DOM at all — only structured data. */
export const JSON_LD_ONLY_PDP = page(`
  <div id="rightContent"></div>
  ${jsonLd(FULL_JSON_LD)}
`);

/** The DOM price candidate exists but is rejected; JSON-LD rescues the field. */
export const PRICE_RESCUED_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Rescued Price Item">Rescued Price Item</h1>
    <div id="goods_price"><span data-type="price">Request a price</span></div>
  </div>
  ${jsonLd({
    '@type': 'Product',
    sku: '601099769178067',
    name: 'Rescued Price Item',
    offers: { price: '19.99', priceCurrency: 'USD' },
  })}
`);

/** A broken ld+json block: absence can no longer be attributed. */
export const MALFORMED_JSON_LD_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Malformed Structured Data Item">Malformed Structured Data Item</h1>
  </div>
  <script type="application/ld+json">{ "this is not valid json</script>
`);

/** No goodsId anywhere: url, canonical, JSON-LD, inline scripts. */
export const NO_GOODS_ID_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Unknown Product">Unknown Product</h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$4.99</span></span></div>
  </div>
`);

/** Hero image element is a data: URI; JSON-LD carries a valid image. */
export const INVALID_HERO_IMAGE_PDP = page(`
  <div id="leftContent">
    <img data-js-main-img="true" src="data:image/png;base64,AAAA" />
  </div>
  <div id="rightContent">
    <h1 aria-label="Placeholder Hero Item">Placeholder Hero Item</h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$15.00</span></span></div>
  </div>
  ${jsonLd({
    '@type': 'Product',
    sku: '601099769178067',
    name: 'Placeholder Hero Item',
    image: ['https://img.kwcdn.com/product/fancy/hero-real.jpg'],
  })}
`);

/** DOM list price equals the JSON-LD price: the validator drops it. */
export const LIST_PRICE_EQUAL_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Equal Price Item">Equal Price Item</h1>
    <div id="goods_price"><span data-type="priceText">US$29.99</span></div>
  </div>
  ${jsonLd({
    '@type': 'Product',
    sku: '601099769178067',
    name: 'Equal Price Item',
    offers: { price: '29.99', priceCurrency: 'USD' },
  })}
`);

/** No feature/spec list nodes at all. */
export const FEATURES_ABSENT_PDP = page(`
  <div id="goodsDetail"></div>
  <div id="rightContent">
    <h1 aria-label="No Features Item">No Features Item</h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$9.99</span></span></div>
  </div>
`);

/** Feature candidates exist but every one is rejected by the length filter. */
export const FEATURES_REJECTED_PDP = page(`
  <div id="goodsDetail">
    <ul><li>ab</li><li>cd</li></ul>
  </div>
  <div id="rightContent">
    <h1 aria-label="Rejected Features Item">Rejected Features Item</h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$9.99</span></span></div>
  </div>
`);

/** The h1 exists but carries no text; JSON-LD supplies the name. */
export const TITLE_RESCUED_PDP = page(`
  <div id="rightContent">
    <h1></h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$11.50</span></span></div>
  </div>
  ${jsonLd({
    '@type': 'Product',
    sku: '601099769178067',
    name: 'Title From Structured Data',
    offers: { price: '11.50', priceCurrency: 'USD' },
  })}
`);

/** A legitimate zero-star rating must not be treated as a validation failure. */
export const ZERO_RATING_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Zero Rating Item">Zero Rating Item</h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$6.00</span></span></div>
    <div id="reviewContent">
      <div role="img" aria-label="0 out of five stars"></div>
      <span aria-label="0 reviews">(0)</span>
    </div>
  </div>
`);

/** JSON-LD carries an aggregateRating whose value is unparseable. */
export const JSON_LD_RATING_REJECTED_PDP = page(`
  <div id="rightContent">
    <h1 aria-label="Unrated Structured Item">Unrated Structured Item</h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$8.25</span></span></div>
  </div>
  ${jsonLd({
    '@type': 'Product',
    sku: '601099769178067',
    name: 'Unrated Structured Item',
    aggregateRating: { ratingValue: 'N/A' },
    offers: { price: '8.25', priceCurrency: 'USD' },
  })}
`);

export const PDP_FIXTURES: TemuPdpFixture[] = [
  { name: 'full', url: PDP_URL, html: FULL_PDP },
  { name: 'minimal', url: PDP_URL, html: MINIMAL_PDP },
  { name: 'price-unparseable', url: PDP_URL, html: PRICE_UNPARSEABLE_PDP },
  { name: 'json-ld-only', url: PDP_URL, html: JSON_LD_ONLY_PDP },
  { name: 'price-rescued', url: PDP_URL, html: PRICE_RESCUED_PDP },
  { name: 'malformed-json-ld', url: PDP_URL, html: MALFORMED_JSON_LD_PDP },
  { name: 'invalid-hero-image', url: PDP_URL, html: INVALID_HERO_IMAGE_PDP },
  { name: 'list-price-equal', url: PDP_URL, html: LIST_PRICE_EQUAL_PDP },
  { name: 'features-absent', url: PDP_URL, html: FEATURES_ABSENT_PDP },
  { name: 'features-rejected', url: PDP_URL, html: FEATURES_REJECTED_PDP },
  { name: 'title-rescued', url: PDP_URL, html: TITLE_RESCUED_PDP },
  { name: 'zero-rating', url: PDP_URL, html: ZERO_RATING_PDP },
  {
    name: 'json-ld-rating-rejected',
    url: PDP_URL,
    html: JSON_LD_RATING_REJECTED_PDP,
  },
];
