/**
 * Phase 0 — Golden snapshot of current parser output (SAD-156).
 *
 * Records the EXACT current output of validateAndNormalizeScrapedProduct for
 * the fixtures already used by the test suite, so Phase 1 (currency, C-1) and
 * Phase 5 (parser performance, H-9) can prove they changed ONLY what they
 * intended to change. Any diff against these snapshots in a later phase must
 * be explicitly justified in that phase's PR description.
 *
 * Fixtures are reused/derived from tests/scraper-accuracy.test.tsx and
 * tests/pricing-deals-bsr.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { validateAndNormalizeScrapedProduct } from '@/lib/scraper/field-parsers';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import { parseProductDetail } from '@/lib/scraper/product-detail';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Parse -> normalize, asserting every product survives validation. */
function normalizedSearch(html: string, pageUrl: string) {
  const raws = parseSearchResults(createDoc(html), pageUrl);
  expect(raws.length).toBeGreaterThan(0);
  return raws.map((raw) => {
    const normalized = validateAndNormalizeScrapedProduct(raw, pageUrl);
    expect(normalized).not.toBeNull();
    return normalized;
  });
}

describe('Phase 0 golden baseline — parser output snapshots', () => {
  it('US search + deals page: discount, list price, deal badge, coupon, past-month sales', () => {
    // Fixture reused from tests/pricing-deals-bsr.test.tsx (SAD-140).
    const html = `
      <div class="s-main-slot">
        <div data-component-type="s-search-result" data-asin="B0DEAL0001">
          <span data-component-type="s-status-badge-component">
            <span class="a-badge-text">Amazon's Choice</span>
          </span>
          <h2>
            <a href="/Wireless-Earbuds/dp/B0DEAL0001">
              <span>Soundcore Wireless Noise Cancelling Earbuds</span>
            </a>
          </h2>
          <div><span>10K+ bought in past month</span></div>
          <span data-a-badge-type="deal">
            <span class="a-badge-text">Limited-time deal</span>
          </span>
          <div data-cy="price-recipe">
            <span class="a-price a-text-price" data-a-strike="true" data-a-color="secondary">
              <span class="a-offscreen">$99.99</span>
            </span>
            <span class="savingsPercentage">-68%</span>
            <span class="a-price" data-a-color="base">
              <span class="a-offscreen">$31.99</span>
            </span>
          </div>
          <span data-component-type="s-coupon-component">
            <span>Save 15% with coupon</span>
          </span>
          <div data-cy="delivery-recipe">
            <span aria-label="FREE delivery Tomorrow, Oct 17">FREE delivery Tomorrow, Oct 17</span>
          </div>
          <img class="s-image" src="https://m.media-amazon.com/images/I/71soundcore._AC_UL320_.jpg" alt="Soundcore Earbuds" />
        </div>

        <div data-component-type="s-search-result" data-asin="B0REG00002">
          <h2>
            <a href="/Standard-Cable/dp/B0REG00002">
              <span>Belkin Braided USB-C Cable 6ft</span>
            </a>
          </h2>
          <div data-cy="price-recipe">
            <span class="a-price" data-a-color="base">
              <span class="a-offscreen">$14.99</span>
            </span>
          </div>
          <img class="s-image" src="https://m.media-amazon.com/images/I/61belkin._AC_UL320_.jpg" alt="Belkin Cable" />
        </div>
      </div>
    `;

    expect(
      normalizedSearch(html, 'https://www.amazon.com/s?k=earbuds')
    ).toMatchInlineSnapshot(`
      [
        {
          "asin": "B0DEAL0001",
          "availability": null,
          "badge": "Amazon's Choice",
          "brand": null,
          "coupon": "Save 15% with coupon",
          "currency": "USD",
          "dealBadge": "Limited-time deal",
          "delivery": "FREE delivery Tomorrow, Oct 17",
          "description": null,
          "discountPercentage": "68% off",
          "features": [],
          "imageUrl": "https://m.media-amazon.com/images/I/71soundcore._AC_UL320_.jpg",
          "isPrime": true,
          "isSponsored": false,
          "listPrice": 99.99,
          "pastMonthSales": "10K+ bought in past month",
          "price": 31.99,
          "rating": null,
          "reviewCount": null,
          "seller": null,
          "source": "search",
          "title": "Soundcore Wireless Noise Cancelling Earbuds",
          "url": "https://www.amazon.com/dp/B0DEAL0001",
        },
        {
          "asin": "B0REG00002",
          "availability": null,
          "brand": null,
          "currency": "USD",
          "description": null,
          "features": [],
          "imageUrl": "https://m.media-amazon.com/images/I/61belkin._AC_UL320_.jpg",
          "isPrime": false,
          "isSponsored": false,
          "price": 14.99,
          "rating": null,
          "reviewCount": null,
          "seller": null,
          "source": "search",
          "title": "Belkin Braided USB-C Cable 6ft",
          "url": "https://www.amazon.com/dp/B0REG00002",
        },
      ]
    `);
  });

  it('DE search: euro symbol, comma decimal, localized rating and review count', () => {
    // Fixture reused from tests/scraper-accuracy.test.tsx.
    const html = `
      <div data-component-type="s-search-result" data-asin="b08n5wrwnw">
        <div data-cy="title-recipe">
          <h2><span>Anker</span></h2>
          <a class="a-link-normal" href="/sspa/click?url=%2FAnker-Charger%2Fdp%2FB08N5WRWNW%2Fref%3Dsr_1_1">
            <h2><span>Anker USB-C 65W Fast Wall Charger</span></h2>
          </a>
        </div>
        <span class="puis-sponsored-label-text">Sponsored</span>
        <i class="a-icon-prime" aria-label="Amazon Prime"></i>
        <div data-cy="price-recipe">
          <span class="a-price">
            <span class="a-price-symbol">€</span>
            <span class="a-price-whole">39,</span>
            <span class="a-price-fraction">99</span>
          </span>
        </div>
        <div data-cy="reviews-block">
          <span class="a-icon-alt">4,8 von 5 Sternen</span>
          <a href="/dp/B08N5WRWNW#customerReviews">
            <span class="s-underline-text">(4.321)</span>
          </a>
        </div>
        <div data-cy="delivery-recipe">
          <span class="a-color-price">Only 4 left in stock - order soon.</span>
        </div>
        <div data-cy="secondary-offer-recipe">
          <span class="a-color-base">Sold by AnkerDirect</span>
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/anker._AC_UL320_.jpg" />
      </div>
    `;

    expect(
      normalizedSearch(html, 'https://www.amazon.de/s?k=usb+c+charger')
    ).toMatchInlineSnapshot(`
      [
        {
          "asin": "B08N5WRWNW",
          "availability": "Only 4 left in stock - order soon.",
          "brand": "Anker",
          "currency": "EUR",
          "description": null,
          "features": [],
          "imageUrl": "https://m.media-amazon.com/images/I/anker._AC_UL320_.jpg",
          "isPrime": true,
          "isSponsored": true,
          "price": 39.99,
          "rating": 4.8,
          "reviewCount": 4321,
          "seller": "AnkerDirect",
          "source": "search",
          "title": "Anker USB-C 65W Fast Wall Charger",
          "url": "https://www.amazon.de/dp/B08N5WRWNW",
        },
      ]
    `);
  });

  it('UK search: pound symbol, same modern card structure', () => {
    // Same card structure as the DE fixture, localized for amazon.co.uk.
    const html = `
      <div data-component-type="s-search-result" data-asin="B09XS7JWHH">
        <div data-cy="title-recipe">
          <h2><span>Sony</span></h2>
          <a class="a-link-normal" href="/Sony-WH-1000XM5/dp/B09XS7JWHH/ref=sr_1_1">
            <h2><span>Sony WH-1000XM5 Wireless Headphones</span></h2>
          </a>
        </div>
        <i class="a-icon-prime" aria-label="Amazon Prime"></i>
        <div data-cy="price-recipe">
          <span class="a-price">
            <span class="a-price-symbol">£</span>
            <span class="a-price-whole">279.</span>
            <span class="a-price-fraction">00</span>
          </span>
        </div>
        <div data-cy="reviews-block">
          <span class="a-icon-alt">4.6 out of 5 stars</span>
          <a href="/dp/B09XS7JWHH#customerReviews">
            <span class="s-underline-text">8,542</span>
          </a>
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/sony._AC_UL320_.jpg" />
      </div>
    `;

    expect(
      normalizedSearch(html, 'https://www.amazon.co.uk/s?k=sony+headphones')
    ).toMatchInlineSnapshot(`
      [
        {
          "asin": "B09XS7JWHH",
          "availability": null,
          "brand": "Sony",
          "currency": "GBP",
          "description": null,
          "features": [],
          "imageUrl": "https://m.media-amazon.com/images/I/sony._AC_UL320_.jpg",
          "isPrime": true,
          "isSponsored": false,
          "price": 279,
          "rating": 4.6,
          "reviewCount": 8542,
          "seller": null,
          "source": "search",
          "title": "Sony WH-1000XM5 Wireless Headphones",
          "url": "https://www.amazon.co.uk/dp/B09XS7JWHH",
        },
      ]
    `);
  });

  it('JP search: yen symbol, thousands separator, no decimals', () => {
    // Same card structure as the DE fixture, localized for amazon.co.jp.
    const html = `
      <div data-component-type="s-search-result" data-asin="B08N5KWB9H">
        <div data-cy="title-recipe">
          <a class="a-link-normal" href="/dp/B08N5KWB9H/ref=sr_1_1">
            <h2><span>Apple AirPods Pro</span></h2>
          </a>
        </div>
        <div data-cy="price-recipe">
          <span class="a-price">
            <span class="a-price-symbol">￥</span>
            <span class="a-price-whole">3,980</span>
          </span>
        </div>
        <div data-cy="reviews-block">
          <span class="a-icon-alt">5つ星のうち4.4</span>
          <a href="/dp/B08N5KWB9H#customerReviews">
            <span class="s-underline-text">(12,345)</span>
          </a>
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/airpods._AC_UL320_.jpg" />
      </div>
    `;

    expect(
      normalizedSearch(html, 'https://www.amazon.co.jp/s?k=airpods')
    ).toMatchInlineSnapshot(`
      [
        {
          "asin": "B08N5KWB9H",
          "availability": null,
          "brand": null,
          "currency": "JPY",
          "description": null,
          "features": [],
          "imageUrl": "https://m.media-amazon.com/images/I/airpods._AC_UL320_.jpg",
          "isPrime": false,
          "isSponsored": false,
          "price": 3980,
          "rating": 4.4,
          "reviewCount": 12345,
          "seller": null,
          "source": "search",
          "title": "Apple AirPods Pro",
          "url": "https://www.amazon.co.jp/dp/B08N5KWB9H",
        },
      ]
    `);
  });

  it('DE search WITHOUT currency symbol: currency resolution', () => {
    // Symbol-less a-offscreen price on amazon.de.
    // NAMED PHASE-1 CHANGE (finding C-1, fixed in SAD-158): this snapshot
    // previously captured the buggy currency "HTTPS://WWW.AMAZON.DE/S?K=GENERIC"
    // (the uppercased page URL). It is now the correct ISO code "EUR" via
    // resolvePageCurrency. Every symbol-bearing fixture above is byte-identical.
    const html = `
      <div data-component-type="s-search-result" data-asin="B0SYMBOL00">
        <h2>
          <a href="/Generic-Product/dp/B0SYMBOL00">
            <span>Generic Symbol-Less Price Product</span>
          </a>
        </h2>
        <div data-cy="price-recipe">
          <span class="a-price" data-a-color="base">
            <span class="a-offscreen">49,99</span>
          </span>
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/generic._AC_UL320_.jpg" />
      </div>
    `;

    expect(
      normalizedSearch(html, 'https://www.amazon.de/s?k=generic')
    ).toMatchInlineSnapshot(`
      [
        {
          "asin": "B0SYMBOL00",
          "availability": null,
          "brand": null,
          "currency": "EUR",
          "description": null,
          "features": [],
          "imageUrl": "https://m.media-amazon.com/images/I/generic._AC_UL320_.jpg",
          "isPrime": false,
          "isSponsored": false,
          "price": 49.99,
          "rating": null,
          "reviewCount": null,
          "seller": null,
          "source": "search",
          "title": "Generic Symbol-Less Price Product",
          "url": "https://www.amazon.de/dp/B0SYMBOL00",
        },
      ]
    `);
  });

  it('category / bestsellers page: p13n grid item with rank and prime icon', () => {
    // Fixture reused from tests/scraper-accuracy.test.tsx.
    const html = `
      <div id="gridItemRoot" class="zg-grid-general-faceout" data-p13n-asin-metadata='{"asin":"B07FZ8S74R"}'>
        <span class="a-size-small">#1</span>
        <div data-asin="B07FZ8S74R">
          <a class="a-link-normal" href="/Echo-Dot/dp/B07FZ8S74R/ref=zg_bs">
            <div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Echo Dot (5th Gen) Smart Speaker</div>
          </a>
          <div class="a-icon-row">
            <span class="a-icon-alt">4.7 out of 5 stars</span>
            <a href="/product-reviews/B07FZ8S74R"><span class="a-size-small">29,410</span></a>
          </div>
          <span class="a-size-small _cDEzb_p13n-sc-price_3mJ9Z">$49.99</span>
          <i class="a-icon-prime"></i>
          <img src="https://images-na.ssl-images-amazon.com/images/I/echo.jpg" />
        </div>
      </div>
    `;

    const pageUrl = 'https://www.amazon.com/Best-Sellers/zgbs';
    const raws = parseCategoryPage(createDoc(html), pageUrl);
    expect(raws).toHaveLength(1);
    const normalized = validateAndNormalizeScrapedProduct(raws[0]!, pageUrl);
    expect(normalized).not.toBeNull();
    expect(normalized).toMatchInlineSnapshot(`
      {
        "asin": "B07FZ8S74R",
        "availability": null,
        "bestSellersRank": "#1",
        "brand": null,
        "currency": "USD",
        "description": null,
        "features": [],
        "imageUrl": "https://images-na.ssl-images-amazon.com/images/I/echo.jpg",
        "isPrime": true,
        "isSponsored": false,
        "price": 49.99,
        "rating": 4.7,
        "reviewCount": 29410,
        "seller": null,
        "source": "category",
        "title": "Echo Dot (5th Gen) Smart Speaker",
        "url": "https://www.amazon.com/dp/B07FZ8S74R",
      }
    `);
  });

  it('product detail page: buy box price wins over carousel ad, hires image preferred', () => {
    // Fixture reused from tests/scraper-accuracy.test.tsx.
    const html = `
      <html>
        <head>
          <link rel="canonical" href="https://www.amazon.co.uk/Sony-WH-1000XM5/dp/B09XS7JWHH" />
        </head>
        <body>
          <div id="sp_detail_carousel">
            <span class="a-price"><span class="a-offscreen">£9.99</span></span>
          </div>

          <h1 id="title"><span id="productTitle">  Sony WH-1000XM5 Wireless Noise Cancelling Headphones  </span></h1>
          <a id="bylineInfo">Visit the Sony Store</a>

          <div id="averageCustomerReviews">
            <span id="acrPopover" title="4.6 out of 5 stars"></span>
            <span id="acrCustomerReviewText">8,542 ratings</span>
          </div>

          <div id="corePriceDisplay_desktop_feature_div">
            <span class="a-price priceToPay">
              <span class="a-offscreen">£279.00</span>
            </span>
          </div>

          <div id="buybox">
            <i class="a-icon-prime"></i>
            <div id="availability"><span> In stock </span></div>
            <div id="tabular-buybox">
              <table>
                <tbody>
                  <tr>
                    <td>Sold by</td>
                    <td class="tabular-buybox-text"><a>Amazon UK</a></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <img
            id="landingImage"
            src="https://m.media-amazon.com/images/I/sony-low.jpg"
            data-old-hires="https://m.media-amazon.com/images/I/sony-hires.jpg"
          />

          <div id="feature-bullets">
            <ul>
              <li><span class="a-list-item">Industry-leading noise cancellation</span></li>
              <li><span class="a-list-item">Up to 30-hour battery life</span></li>
            </ul>
          </div>

          <div id="productDescription">
            <p>Premium over-ear headphones with 8 microphones and Auto NC Optimizer.</p>
          </div>
        </body>
      </html>
    `;

    const pageUrl = 'https://www.amazon.co.uk/dp/B09XS7JWHH';
    const raw = parseProductDetail(createDoc(html), pageUrl);
    expect(raw).not.toBeNull();
    const normalized = validateAndNormalizeScrapedProduct(raw!, pageUrl);
    expect(normalized).not.toBeNull();
    expect(normalized).toMatchInlineSnapshot(`
      {
        "asin": "B09XS7JWHH",
        "availability": "In stock",
        "brand": "Sony",
        "currency": "GBP",
        "description": "Premium over-ear headphones with 8 microphones and Auto NC Optimizer.",
        "features": [
          "Industry-leading noise cancellation",
          "Up to 30-hour battery life",
        ],
        "imageUrl": "https://m.media-amazon.com/images/I/sony-hires.jpg",
        "isPrime": true,
        "isSponsored": false,
        "price": 279,
        "rating": 4.6,
        "reviewCount": 8542,
        "seller": "Amazon UK",
        "source": "detail",
        "title": "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
        "url": "https://www.amazon.co.uk/dp/B09XS7JWHH",
      }
    `);
  });
});
