import { describe, expect, it } from 'vitest';
import {
  inferCurrencyFromUrl,
  parsePrice,
  parsePriceFromElements,
} from '@/lib/utils/price-parser';
import {
  extractASIN,
  isValidASIN,
  normalizeASIN,
  resolveProductUrl,
} from '@/lib/utils/amazon-url';
import {
  cleanAvailability,
  cleanBrand,
  cleanSeller,
  extractBestImageUrl,
  parseRating,
  parseReviewCount,
  validateAndNormalizeScrapedProduct,
} from '@/lib/scraper/field-parsers';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { parseProductDetail } from '@/lib/scraper/product-detail';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import { detectPageType } from '@/lib/scraper/page-detector';
import { DeduplicationEngine } from '@/lib/scraper/dedup';
import { SettingsSchema } from '@/lib/schemas/settings';
import { ProductSchema } from '@/lib/schemas/product';
import {
  DEFAULT_VISIBLE_COLUMNS,
  EXPORT_COLUMNS,
  getExportColumnsFromSettings,
} from '@/lib/export/types';
import { buildCSVContent } from '@/lib/export/csv';
import { columns, getColumnsForSettings } from '@/entrypoints/sidepanel/table/columns';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('price and currency parser accuracy', () => {
  it('parses US, UK, EU, JP, IN, CA, and AU prices with leading or trailing symbols', () => {
    expect(parsePrice('$29.99')).toEqual({ value: 29.99, currency: 'USD' });
    expect(parsePrice('US$1,299.50')).toEqual({
      value: 1299.5,
      currency: 'USD',
    });
    expect(parsePrice('CA$34.95')).toEqual({ value: 34.95, currency: 'CAD' });
    expect(parsePrice('AU$59.00')).toEqual({ value: 59, currency: 'AUD' });
    expect(parsePrice('£1,249.50')).toEqual({
      value: 1249.5,
      currency: 'GBP',
    });
    expect(parsePrice('49,99 €')).toEqual({ value: 49.99, currency: 'EUR' });
    expect(parsePrice('1.299,99 €')).toEqual({
      value: 1299.99,
      currency: 'EUR',
    });
    expect(parsePrice('¥3,980')).toEqual({ value: 3980, currency: 'JPY' });
    expect(parsePrice('₹1,49,999.00')).toEqual({
      value: 149999,
      currency: 'INR',
    });
    expect(parsePrice('$19.99 - $29.99')).toEqual({
      value: 19.99,
      currency: 'USD',
    });
  });

  it('infers regional currency from URL when only a generic symbol or split elements exist', () => {
    expect(inferCurrencyFromUrl('https://www.amazon.de/dp/B08N5WRWNW')).toBe(
      'EUR'
    );
    expect(inferCurrencyFromUrl('https://www.amazon.co.uk/dp/B08N5WRWNW')).toBe(
      'GBP'
    );
    expect(inferCurrencyFromUrl('https://www.amazon.co.jp/dp/B08N5WRWNW')).toBe(
      'JPY'
    );

    const doc = createDoc(`
      <div>
        <span class="a-price-symbol">¥</span>
        <span class="a-price-whole">3,980</span>
      </div>
    `);
    expect(
      parsePriceFromElements(
        doc.querySelector('.a-price-whole'),
        doc.querySelector('.a-price-fraction'),
        doc.querySelector('.a-price-symbol'),
        'https://www.amazon.co.jp/s?k=headphones'
      )
    ).toEqual({ value: 3980, currency: 'JPY' });
  });
});

describe('Amazon URL and ASIN normalization', () => {
  it('validates and extracts ASINs across standard, mobile, and sponsored redirect URLs', () => {
    expect(isValidASIN('B08N5WRWNW')).toBe(true);
    expect(isValidASIN('b08n5wrwnw')).toBe(true);
    expect(isValidASIN('invalid')).toBe(false);
    expect(normalizeASIN('  b08n5wrwnw ')).toBe('B08N5WRWNW');

    expect(
      extractASIN(
        'https://www.amazon.co.uk/Sony-Headphones/dp/b08n5wrwnw/ref=sr_1_1?qid=123'
      )
    ).toBe('B08N5WRWNW');
    expect(
      extractASIN(
        'https://www.amazon.com/sspa/click?ie=UTF8&spc=MTo1&url=%2FSony%2Fdp%2FB08N5WRWNW%2Fref%3Dsr_1_1_sspa'
      )
    ).toBe('B08N5WRWNW');

    expect(
      resolveProductUrl(
        '/sspa/click?url=%2Fdp%2FB08N5WRWNW%2Fref%3Dsr_1_1',
        'B08N5WRWNW',
        'https://www.amazon.de/s?k=sony'
      )
    ).toBe('https://www.amazon.de/dp/B08N5WRWNW');
  });
});

describe('field parsers and source validation', () => {
  it('parses international ratings and avoids mistaking rating numbers for review counts', () => {
    expect(parseRating('4.6 out of 5 stars')).toBe(4.6);
    expect(parseRating('4,7 von 5 Sternen')).toBe(4.7);
    expect(parseRating('4,5 sur 5 étoiles')).toBe(4.5);
    expect(parseRating('5つ星のうち4.3')).toBe(4.3);

    expect(parseReviewCount('1,284 ratings')).toBe(1284);
    expect(parseReviewCount('4.5 out of 5 stars 1,284 ratings')).toBe(1284);
    expect(parseReviewCount('4.5 out of 5 stars')).toBeNull();
    expect(parseReviewCount('(2.450)')).toBe(2450);
    expect(parseReviewCount('1.5K ratings')).toBe(1500);
  });

  it('cleans brand, availability, seller, and picks highest resolution image URL', () => {
    expect(cleanBrand('Visit the Anker Store')).toBe('Anker');
    expect(cleanBrand('Brand: Sony')).toBe('Sony');
    expect(cleanAvailability('  In Stock   ')).toBe('In Stock');
    expect(cleanSeller('Ships from and sold by Amazon.com.')).toBe(
      'Amazon.com'
    );
    expect(cleanSeller('Sold by AnkerDirect and Fulfilled by Amazon.')).toBe(
      'AnkerDirect'
    );

    const doc = createDoc(`
      <img
        src="https://m.media-amazon.com/images/I/low._AC_UL320_.jpg"
        data-a-dynamic-image='{"https://m.media-amazon.com/images/I/low._AC_UL320_.jpg":[320,320],"https://m.media-amazon.com/images/I/high._AC_SL1500_.jpg":[1500,1500]}'
      />
    `);
    expect(extractBestImageUrl(doc.querySelector('img'))).toBe(
      'https://m.media-amazon.com/images/I/high._AC_SL1500_.jpg'
    );
  });
});

describe('search, product detail, and category DOM scrapers', () => {
  it('captures all 13 core fields accurately from modern Amazon search result cards', () => {
    const doc = createDoc(`
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
    `);

    const results = parseSearchResults(
      doc,
      'https://www.amazon.de/s?k=usb+c+charger'
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.de/dp/B08N5WRWNW',
      title: 'Anker USB-C 65W Fast Wall Charger',
      price: 39.99,
      currency: 'EUR',
      rating: 4.8,
      reviewCount: 4321,
      imageUrl: 'https://m.media-amazon.com/images/I/anker._AC_UL320_.jpg',
      isSponsored: true,
      isPrime: true,
      brand: 'Anker',
      availability: 'Only 4 left in stock - order soon.',
      seller: 'AnkerDirect',
      description: null,
      features: [],
      source: 'search',
    });
  });

  it('extracts and cross-verifies all fields on a product detail page while ignoring carousel ad prices', () => {
    const doc = createDoc(`
      <html>
        <head>
          <link rel="canonical" href="https://www.amazon.co.uk/Sony-WH-1000XM5/dp/B09XS7JWHH" />
        </head>
        <body>
          <!-- Sponsored carousel earlier in DOM that should NOT override Buy Box price -->
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
    `);

    const product = parseProductDetail(
      doc,
      'https://www.amazon.co.uk/dp/B09XS7JWHH'
    );
    expect(product).not.toBeNull();
    expect(product).toEqual({
      asin: 'B09XS7JWHH',
      url: 'https://www.amazon.co.uk/dp/B09XS7JWHH',
      title: 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones',
      price: 279,
      currency: 'GBP',
      rating: 4.6,
      reviewCount: 8542,
      imageUrl: 'https://m.media-amazon.com/images/I/sony-hires.jpg',
      isSponsored: false,
      isPrime: true,
      brand: 'Sony',
      availability: 'In stock',
      seller: 'Amazon UK',
      description:
        'Premium over-ear headphones with 8 microphones and Auto NC Optimizer.',
      features: [
        'Industry-leading noise cancellation',
        'Up to 30-hour battery life',
      ],
      source: 'detail',
    });

    // Verify full compatibility with ProductSchema
    const schemaCheck = ProductSchema.safeParse({
      ...product,
      collectedAt: new Date().toISOString(),
      sessionKey: 'session_test',
    });
    expect(schemaCheck.success).toBe(true);
  });

  it('resolves currency to a valid ISO code for every DE price markup, incl. symbol-less (C-1, SAD-158)', () => {
    const doc = createDoc(`
      <div data-component-type="s-search-result" data-asin="B0DESPLIT1">
        <h2><a href="/Split-Markup/dp/B0DESPLIT1"><span>DE Split Markup Product</span></a></h2>
        <div data-cy="price-recipe">
          <span class="a-price">
            <span class="a-price-symbol">€</span>
            <span class="a-price-whole">1.299,</span>
            <span class="a-price-fraction">99</span>
          </span>
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/split._AC_UL320_.jpg" />
      </div>
      <div data-component-type="s-search-result" data-asin="B0DEOFFSCR">
        <h2><a href="/Offscreen-Symbol/dp/B0DEOFFSCR"><span>DE Offscreen Symbol Product</span></a></h2>
        <div data-cy="price-recipe">
          <span class="a-price" data-a-color="base">
            <span class="a-offscreen">1.299,99 €</span>
          </span>
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/offscreen._AC_UL320_.jpg" />
      </div>
      <div data-component-type="s-search-result" data-asin="B0DENOSYMB">
        <h2><a href="/Symbol-Less/dp/B0DENOSYMB"><span>DE Symbol-Less Product</span></a></h2>
        <div data-cy="price-recipe">
          <span class="a-price" data-a-color="base">
            <span class="a-offscreen">1.299</span>
          </span>
        </div>
        <img class="s-image" src="https://m.media-amazon.com/images/I/nosymbol._AC_UL320_.jpg" />
      </div>
    `);

    const results = parseSearchResults(doc, 'https://www.amazon.de/s?k=laptop');
    expect(results).toHaveLength(3);

    // No product may carry a URL (or anything non-ISO) as its currency.
    for (const product of results) {
      expect(product.currency).toMatch(/^[A-Z]{3}$/);
      expect(product.currency).toBe('EUR');
    }

    // The 1000x defect: EUR thousands separator must not collapse to 1.3.
    const split = results.find((p) => p.asin === 'B0DESPLIT1')!;
    const offscreen = results.find((p) => p.asin === 'B0DEOFFSCR')!;
    const symbolLess = results.find((p) => p.asin === 'B0DENOSYMB')!;
    expect(split.price).toBe(1299.99);
    expect(offscreen.price).toBe(1299.99);
    expect(symbolLess.price).toBe(1299);
  });

  it('parses category and bestseller pages without nested data-asin duplication or .a-size-small price/rank confusion', () => {
    const doc = createDoc(`
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
    `);

    const items = parseCategoryPage(
      doc,
      'https://www.amazon.com/Best-Sellers/zgbs'
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      asin: 'B07FZ8S74R',
      url: 'https://www.amazon.com/dp/B07FZ8S74R',
      title: 'Echo Dot (5th Gen) Smart Speaker',
      price: 49.99,
      currency: 'USD',
      rating: 4.7,
      reviewCount: 29410,
      imageUrl: 'https://images-na.ssl-images-amazon.com/images/I/echo.jpg',
      isPrime: true,
      isSponsored: false,
      source: 'category',
    });
  });

  it('enriches previously null fields when DeduplicationEngine.mergeAndFilterNew runs after lazy hydration', () => {
    const dedup = new DeduplicationEngine();
    const initial = validateAndNormalizeScrapedProduct({
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      title: 'Test Product',
      price: null,
      currency: null,
      source: 'search',
    })!;
    const collected = dedup.filterNew([initial]);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.price).toBeNull();

    const hydrated = validateAndNormalizeScrapedProduct({
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      title: 'Test Product',
      price: 45.5,
      currency: 'USD',
      brand: 'TestBrand',
      seller: 'TestSeller',
      source: 'search',
    })!;
    const { newProducts, updatedExisting } = dedup.mergeAndFilterNew(
      collected,
      [hydrated]
    );
    expect(newProducts).toHaveLength(0);
    expect(updatedExisting).toBe(true);
    expect(collected[0]?.price).toBe(45.5);
    expect(collected[0]?.currency).toBe('USD');
    expect(collected[0]?.brand).toBe('TestBrand');
    expect(collected[0]?.seller).toBe('TestSeller');
  });
});

describe('default enabled fields across Settings, Preview Table, and Exports', () => {
  it('enables all core fields plus description and features by default (SAD-333)', () => {
    const defaults = SettingsSchema.parse({});
    expect(defaults.enabledFields).toEqual({
      title: true,
      asin: true,
      url: true,
      price: true,
      listPrice: true,
      discountPercentage: true,
      dealBadge: true,
      currency: true,
      rating: true,
      reviewCount: true,
      bestSellersRank: true,
      pastMonthSales: true,
      coupon: true,
      badge: true,
      delivery: true,
      imageUrl: true,
      isSponsored: true,
      isPrime: true,
      brand: true,
      availability: true,
      seller: true,
      description: true,
      features: true,
    });

    expect(DEFAULT_VISIBLE_COLUMNS).toEqual([
      'ASIN',
      'Title',
      'Price',
      'List Price',
      'Discount',
      'Deal',
      'Currency',
      'Rating',
      'Reviews',
      'Best Sellers Rank',
      'Monthly Sales',
      'Coupon',
      'Badge',
      'Delivery',
      'Brand',
      'Seller',
      'Availability',
      'Sponsored',
      'Prime',
      'Image',
      'URL',
      'Description',
      'Features',
      'Source',
      'Collected At',
    ]);
    expect(
      getExportColumnsFromSettings(defaults.enabledFields)
    ).toEqual(DEFAULT_VISIBLE_COLUMNS);

    // Table columns: select + rowNumber (#) + 21 core/pricing/deal/BSR/market fields
    // + description + features + source = 26 columns by default (SAD-333).
    expect(columns).toHaveLength(26);
    expect(getColumnsForSettings(defaults.enabledFields)).toHaveLength(26);

    // Both stay ordinary per-field toggles: turning them off removes them again.
    const allEnabled = {
      ...defaults.enabledFields,
      description: true,
      features: true,
    };
    expect(getColumnsForSettings(allEnabled)).toHaveLength(26);
    expect(getExportColumnsFromSettings(allEnabled)).toContain('Description');
    expect(getExportColumnsFromSettings(allEnabled)).toContain('Features');

    const bothOff = {
      ...defaults.enabledFields,
      description: false,
      features: false,
    };
    expect(getColumnsForSettings(bothOff)).toHaveLength(24);
    expect(getExportColumnsFromSettings(bothOff)).not.toContain('Description');
    expect(getExportColumnsFromSettings(bothOff)).not.toContain('Features');
  });

  it('owns the default column list in exactly one module, and every listed export column exists (SAD-346)', async () => {
    // The export surface can render every column it claims by default.
    for (const column of DEFAULT_VISIBLE_COLUMNS) {
      expect(
        Object.prototype.hasOwnProperty.call(EXPORT_COLUMNS, column),
        `EXPORT_COLUMNS cannot render "${column}"`
      ).toBe(true);
    }

    // 'Collected At' is export-only by design: the table has no such accessor,
    // so nothing promises it in the Preview.
    const tableIds = getColumnsForSettings(
      SettingsSchema.parse({}).enabledFields
    ).map((column) => {
      const shape = column as unknown as { id?: string; accessorKey?: string };
      return shape.id ?? shape.accessorKey;
    });
    expect(tableIds).not.toContain('collectedAt');
    expect(tableIds).not.toContain('Collected At');

    // Only the export module declares a default-visible list.
    const engineConstants = (await import('@/engines/amazon/constants/defaults')) as Record<
      string,
      unknown
    >;
    expect(engineConstants.AMAZON_DEFAULT_VISIBLE_COLUMNS).toBeUndefined();
    expect(engineConstants.DEFAULT_VISIBLE_COLUMNS).toBeUndefined();

    const appConstants = (await import('@/constants/defaults')) as Record<
      string,
      unknown
    >;
    expect(appConstants.DEFAULT_VISIBLE_COLUMNS).toBeUndefined();
  });

  it('honours the Best Sellers Rank and Monthly Sales toggles in exports (SAD-345)', () => {
    const defaults = SettingsSchema.parse({});
    const bothOff = {
      ...defaults.enabledFields,
      bestSellersRank: false,
      pastMonthSales: false,
    };

    const columns = getExportColumnsFromSettings(bothOff);
    expect(columns).not.toContain('Best Sellers Rank');
    expect(columns).not.toContain('Monthly Sales');
    // Only those two leave; the always-present columns and the neighbours stay.
    expect(columns).toEqual(
      DEFAULT_VISIBLE_COLUMNS.filter(
        (column) => column !== 'Best Sellers Rank' && column !== 'Monthly Sales'
      )
    );
    expect(columns).toContain('Reviews');
    expect(columns).toContain('Coupon');
    expect(columns[0]).toBe('ASIN');
    expect(columns.slice(-1)).toEqual(['Collected At']);

    // ...and the CSV writer really drops the header cells.
    const csv = buildCSVContent(
      [
        {
          asin: 'B08N5WRWNW',
          url: 'https://www.amazon.com/dp/B08N5WRWNW',
          title: 'Anker 65W Charger',
          price: 19.99,
          currency: 'USD',
          bestSellersRank: '#5 in Electronics',
          pastMonthSales: '10K+ bought in past month',
          source: 'search',
          collectedAt: '2026-10-19T00:00:00.000Z',
        },
      ] as never,
      columns,
      false
    );
    const header = csv.split('\n')[0]!;
    expect(header).not.toContain('Best Sellers Rank');
    expect(header).not.toContain('Monthly Sales');
    expect(csv).not.toContain('#5 in Electronics');
    expect(csv).not.toContain('10K+ bought in past month');

    // Defaults are untouched: the same order as before the change.
    expect(getExportColumnsFromSettings(defaults.enabledFields)).toEqual(
      DEFAULT_VISIBLE_COLUMNS
    );
  });

  it('detects search, product-detail, bestsellers, and category page types accurately', () => {
    const emptyDoc = createDoc('<div></div>');
    expect(
      detectPageType('https://www.amazon.com/dp/b08n5wrwnw', emptyDoc)
    ).toBe('product-detail');
    expect(
      detectPageType('https://www.amazon.com/s?k=keyboard', emptyDoc)
    ).toBe('search');
    expect(
      detectPageType('https://www.amazon.com/gp/new-releases/electronics', emptyDoc)
    ).toBe('bestsellers');
    expect(
      detectPageType('https://www.amazon.com/b?node=172282', emptyDoc)
    ).toBe('category');
  });
});
