/**
 * SAD-357 — Variations & Weight fields across the Amazon engine.
 *
 * Covers every layer end-to-end without mocks where real modules exist:
 *   1. Weight & Variation normalizers (`normalizeWeightValue`, `formatVariationDimensionsSummary`)
 *   2. Real 2026 PDP DOM layouts (legacy techSpec, 2026 expander `prodDetTable`,
 *      `detailBullets` bidi marks, `Package Weight` & semicolon `Product Dimensions`
 *      fallbacks, `#aplus` strong-header tables, `#similarities_feature_div` exclusion,
 *      `twister-js-init-dpx-data` balanced JSON + singleton guard, inline/classic
 *      Twister DOM, and Book/Media `#tmmSwatches`)
 *   3. Search & Category card `.s-color-swatch-container` extraction + badge guards
 *   4. Dedup (`mergeScrapedProductFields`), Dexie (`addProducts`), Offscreen PDP parse
 *      (`parsePdpHtml`), and `enrichSavedProduct` search->detail upgrade + `SAD-352` diagnostics
 *   5. Physical-mass (`g`) and variation-count sorting (`sortProducts`)
 *   6. Preview Table rendering, blank empty cells (`SAD-348`), `SAD-358` `ExpandableCell`
 *      + per-dimension `CellExpandModal`, global text filter, and `SettingsOverlay` toggles
 *   7. CSV, Clipboard TSV, and Excel (`.xlsx`) export round-trips
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import * as XLSX from 'xlsx';

import {
  DEFAULT_ENABLED_FIELDS,
} from '@/engines/amazon/constants/defaults';
import {
  collectMissingDetailFields,
  enrichSavedProduct,
} from '@/engines/amazon/background/enrich-saved-product';
import { db } from '@/engines/amazon/db/database';
import { addProducts } from '@/engines/amazon/db/products';
import { saveQuickProduct } from '@/engines/amazon/db/quick-save';
import { getSettings, updateSettings } from '@/engines/amazon/db/settings';
import { buildClipboardTSV } from '@/engines/amazon/export/clipboard';
import { buildCSVContent } from '@/engines/amazon/export/csv';
import { buildExcelWorkbookBuffer } from '@/engines/amazon/export/excel';
import {
  DEFAULT_VISIBLE_COLUMNS,
  getExportColumnsFromSettings,
} from '@/engines/amazon/export/types';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';
import { parseAmazonCategoryCard } from '@/engines/amazon/scraper/category-page';
import { mergeScrapedProductFields } from '@/engines/amazon/scraper/dedup';
import {
  formatVariationDimensionsSummary,
  normalizeWeightValue,
} from '@/engines/amazon/scraper/field-parsers';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';
import { parseAmazonSearchCard } from '@/engines/amazon/scraper/search-results';
import type { Product, ScrapedAmazonProduct } from '@/engines/amazon/types';
import { Header } from '@/entrypoints/sidepanel/components/Header';
import { SettingsOverlay } from '@/entrypoints/sidepanel/components/SettingsOverlay';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import {
  parseSortableVariationCount,
  parseSortableWeightGrams,
  sortProducts,
} from '@/lib/sorting/product-sorter';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 52,
        end: (index + 1) * 52,
        size: 52,
      })),
  }),
}));

const PDP_URL = 'https://www.amazon.com/dp/B0VARWGHT1';

function pdpDoc(body: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>
       <h1 id="productTitle">Precision Studio Scale</h1>
       <input id="ASIN" value="B0VARWGHT1" />
       <div id="corePriceDisplay_desktop_feature_div">
         <span class="a-price"><span class="a-offscreen">$29.99</span></span>
       </div>
       ${body}
     </body></html>`,
    'text/html',
  );
}

function searchCardElement(inner: string, asin = 'B0SRCHVAR1'): Element {
  const doc = new DOMParser().parseFromString(
    `<div data-component-type="s-search-result" data-asin="${asin}">
       <div data-cy="title-recipe">
         <a href="/dp/${asin}"><h2><span>Running Tee Shirt</span></h2></a>
       </div>
       <div data-cy="price-recipe">
         <span class="a-price"><span class="a-offscreen">$19.99</span></span>
       </div>
       ${inner}
     </div>`,
    'text/html',
  );
  return doc.body.firstElementChild!;
}

function makeProduct(asin: string, overrides: Partial<Product> = {}): Product {
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: `Product ${asin}`,
    price: 24.99,
    currency: 'USD',
    rating: 4.6,
    reviewCount: 120,
    imageUrl: 'https://m.media-amazon.com/images/I/sample.jpg',
    isSponsored: false,
    isPrime: true,
    brand: 'Acme',
    availability: 'In Stock',
    seller: 'Amazon.com',
    description: null,
    features: [],
    source: 'detail',
    collectedAt: '2026-10-20T00:00:00.000Z',
    sessionKey: 'sess-sad-357',
    ...overrides,
  };
}

describe('normalizeWeightValue (SAD-357)', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ['250 milligrams', '250 mg'],
    ['0.31 grams', '0.31 g'],
    ['1 gram', '1 g'],
    ['0.19 Kilograms', '0.19 kg'],
    ['2.50 kg', '2.5 kg'],
    ['9.12 ounces', '9.12 oz'],
    ['1 pound', '1 lb'],
    ['1.73 pounds', '1.73 lbs'],
    ['\u200e1.73 pounds\u200f', '1.73 lbs'],
    ['1 lb 4 oz', '1 lb 4 oz'],
    ['2 pounds 8 ounces', '2 lbs 8 oz'],
    ['10.6 oz. (300 grams)', '10.6 oz'],
    ['1,5 kg', '1.5 kg'],
    ['1,250 grams', '1250 g'],
    // Non-mass strings must never produce bogus weights
    ['12 x 8 x 4 inches', null],
    ['0 kg', null],
    ['Heavy duty steel', null],
    ['See product manual', null],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ];

  it.each(cases)('%j -> %j', (input, expected) => {
    expect(normalizeWeightValue(input)).toBe(expected);
  });
});

describe('formatVariationDimensionsSummary (SAD-357)', () => {
  it('preserves all dimensions and option values losslessly without truncation', () => {
    const colors = Array.from({ length: 14 }, (_, idx) => `Color ${idx + 1}`);
    const summary = formatVariationDimensionsSummary(
      [
        { label: 'Size:', values: ['S', 'M', 'L', 'XL'] },
        { label: 'Color', values: colors },
      ],
      56,
    );
    expect(summary).toBe(
      `56 (Size: S, M, L, XL; Color: ${colors.join(', ')})`,
    );
    expect(summary).not.toContain('more');
  });

  it('rejects singleton 1-variant definitions so non-variant items stay blank', () => {
    expect(
      formatVariationDimensionsSummary(
        [{ label: 'Size', values: ['1 Twin Pack'] }],
        1,
      ),
    ).toBeNull();
    expect(formatVariationDimensionsSummary([], 1)).toBeNull();
    expect(formatVariationDimensionsSummary([], null)).toBeNull();
  });
});

describe('parseAmazonProductDetail — Weight shapes & priority waterfall', () => {
  it('extracts from 2026 expander prodDetTable when legacy #prodDetails is absent', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <div id="productDetails_expanderTables_depthLeftSections">
          <table class="a-keyvalue prodDetTable">
            <tr>
              <th class="a-color-secondary a-size-base prodDetSectionEntry">Item Weight</th>
              <td class="a-size-base prodDetAttrValue">\u200e0.19 Kilograms</td>
            </tr>
          </table>
        </div>
      `),
      PDP_URL,
    );
    expect(parsed?.weight).toBe('0.19 kg');
  });

  it('extracts from detailBullets list with Amazon bidi marks', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <div id="detailBulletsWrapper_feature_div">
          <ul>
            <li><span class="a-list-item">
              <span class="a-text-bold">Item Weight \u200f : \u200e</span>
              <span>1.73 pounds</span>
            </span></li>
          </ul>
        </div>
      `),
      PDP_URL,
    );
    expect(parsed?.weight).toBe('1.73 lbs');
  });

  it('prefers Item Weight over Package Weight even when Package Weight appears earlier', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <table id="productDetails_techSpec_section_1">
          <tr><th>Package Weight</th><td>1.40 Kilograms</td></tr>
          <tr><th>Item Weight</th><td>9.12 ounces</td></tr>
        </table>
      `),
      PDP_URL,
    );
    expect(parsed?.weight).toBe('9.12 oz');
  });

  it('falls back to Package Weight and semicolon Product Dimensions when Item Weight is absent', () => {
    const pkgOnly = parseAmazonProductDetail(
      pdpDoc(`
        <table id="productDetails_techSpec_section_1">
          <tr><th>Item Package Weight</th><td>0.85 Kilograms</td></tr>
        </table>
      `),
      PDP_URL,
    );
    expect(pkgOnly?.weight).toBe('0.85 kg');

    const dimsCombined = parseAmazonProductDetail(
      pdpDoc(`
        <div id="detailBulletsWrapper_feature_div">
          <ul>
            <li><span class="a-text-bold">Product Dimensions :</span> 10 x 5 x 3 inches; 14.4 Ounces</li>
          </ul>
        </div>
      `),
      PDP_URL,
    );
    expect(dimsCombined?.weight).toBe('14.4 oz');
  });

  it('falls back to #aplus brand spec table with strong header cells', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <div id="aplus">
          <table>
            <tr>
              <td><p><strong>Weight</strong></p></td>
              <td><p>10.6 oz. (300 grams)</p></td>
            </tr>
          </table>
        </div>
      `),
      PDP_URL,
    );
    expect(parsed?.weight).toBe('10.6 oz');
  });

  it('ignores non-mass weight labels and excluded comparison subtrees', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <table id="productDetails_techSpec_section_1">
          <tr><th>Maximum Weight Recommendation</th><td>300 Pounds</td></tr>
          <tr><th>Supported Weight</th><td>50 Kilograms</td></tr>
          <tr><th>Paper Weight</th><td>80 Grams</td></tr>
        </table>
        <div id="similarities_feature_div">
          <table id="productDetails_techSpec_section_2">
            <tr><th>Item Weight</th><td>5.5 pounds</td></tr>
          </table>
        </div>
      `),
      PDP_URL,
    );
    expect(parsed?.weight).toBeUndefined();
  });
});

describe('parseAmazonProductDetail — Variations waterfall', () => {
  it('extracts full multi-dimension breakdown from twister-js-init-dpx-data script with JS string concatenation', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <script type="text/javascript">
          P.register('twister-js-init-dpx-data', function() {
            var dataToReturn = {
              "ajaxUrlParams": "foo=1" + "&bar=2",
              "dimensions": ["size_name", "color_name"],
              "variationDisplayLabels": {"size_name": "Size", "color_name": "Color"},
              "variationValues": {
                "size_name": ["1 Pack", "6 Pack"],
                "color_name": ["Black", "Cobalt Blue", "Miami", "Purple", "Red"]
              },
              "num_total_variations": 10
            };
            return dataToReturn;
          });
        </script>
      `),
      PDP_URL,
    );
    expect(parsed?.variations).toBe(
      '10 (Size: 1 Pack, 6 Pack; Color: Black, Cobalt Blue, Miami, Purple, Red)',
    );
  });

  it('recovers option values from dimensionValuesDisplayData when variationValues is omitted', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <script type="text/javascript">
          P.register('twister-js-init-dpx-data', function() {
            return {
              "dimensions": ["size_name", "color_name"],
              "variationDisplayLabels": {"size_name": "Capacity", "color_name": "Finish"},
              "dimensionValuesDisplayData": {
                "B000000001": ["128GB", "Space Black"],
                "B000000002": ["256GB", "Space Black"],
                "B000000003": ["256GB", "Silver"]
              }
            };
          });
        </script>
      `),
      PDP_URL,
    );
    expect(parsed?.variations).toBe(
      '3 (Capacity: 128GB, 256GB; Finish: Space Black, Silver)',
    );
  });

  it('omits variations when twister-js-init-dpx-data declares a singleton (num_total_variations = 1)', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <script type="text/javascript">
          P.register('twister-js-init-dpx-data', function() {
            return {
              "dimensions": ["size_name"],
              "variationDisplayLabels": {"size_name": "Size"},
              "variationValues": {"size_name": ["1 Twin Pack"]},
              "num_total_variations": 1
            };
          });
        </script>
      `),
      PDP_URL,
    );
    expect(parsed?.variations).toBeUndefined();
  });

  it('falls back cleanly to inline Twister DOM rows and strips embedded price spans', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <div id="inline-twister-row-color_name">
          <div id="inline-twister-dim-title-color_name">
            <span class="a-color-secondary">Color:</span>
            <span class="a-color-base">Midnight</span>
          </div>
          <ul>
            <li data-asin="B000000011"><img alt="Midnight" /></li>
            <li data-asin="B000000012"><img alt="Starlight" /></li>
            <li data-asin="B000000013"><img alt="Product Red" /></li>
          </ul>
        </div>
        <div id="inline-twister-row-size_name">
          <div id="inline-twister-dim-title-size_name">
            <span class="a-color-secondary">Size:</span>
            <span class="a-color-base">128GB</span>
          </div>
          <ul>
            <li data-asin="B000000011"><span class="a-button-text">128GB <span class="twisterSwatchPrice">$599.00</span></span></li>
            <li data-asin="B000000014"><span class="a-button-text">256GB <span class="twisterSwatchPrice">$699.00</span></span></li>
          </ul>
        </div>
      `),
      PDP_URL,
    );
    expect(parsed?.variations).toBe(
      '6 (Color: Midnight, Starlight, Product Red; Size: 128GB, 256GB)',
    );
  });

  it('extracts book/media format editions from #tmmSwatches', () => {
    const parsed = parseAmazonProductDetail(
      pdpDoc(`
        <div id="tmmSwatches">
          <ul>
            <li class="swatchElement"><span class="slot-title"><span>Kindle</span></span></li>
            <li class="swatchElement"><span class="slot-title"><span>Audiobook</span></span></li>
            <li class="swatchElement"><span class="slot-title"><span>Hardcover</span></span></li>
            <li class="swatchElement"><span class="slot-title"><span>Paperback</span></span></li>
          </ul>
        </div>
      `),
      PDP_URL,
    );
    expect(parsed?.variations).toBe(
      '4 (Format: Kindle, Audiobook, Hardcover, Paperback)',
    );
  });
});

describe('Search & Category card variation swatch extraction', () => {
  it('extracts named swatches combined with +N overflow count', () => {
    const card = searchCardElement(`
      <div class="s-color-swatch-container">
        <span data-csa-c-content-id="color-swatch-link"><a aria-label="Black" href="/dp/B0SRCHVAR1"></a></span>
        <span data-csa-c-content-id="color-swatch-link"><a aria-label="Navy" href="/dp/B0SRCHVAR2"></a></span>
        <span data-csa-c-content-id="color-swatch-link"><a aria-label="Olive" href="/dp/B0SRCHVAR3"></a></span>
        <a data-csa-c-content-id="color-swatch-more-link" data-csa-c-swatch-remaining-count="+4 other colors/patterns">+4</a>
      </div>
    `);
    const parsed = parseAmazonSearchCard(card, 'https://www.amazon.com/s?k=tee');
    expect(parsed?.variations).toBe('7 (Color: Black, Navy, Olive, +4 more)');
  });

  it('supports count-only "+3 other colors/patterns" cards with zero swatch circles', () => {
    const card = searchCardElement(`
      <div class="s-color-swatch-container">
        <a data-csa-c-content-id="color-swatch-more-link" aria-label="+3 other colors/patterns" href="/dp/B0SRCHVAR1">+3 other colors/patterns</a>
      </div>
    `);
    const parsed = parseAmazonSearchCard(card, 'https://www.amazon.com/s?k=tee');
    expect(parsed?.variations).toBe('4 (+3 other colors/patterns)');
  });

  it('ignores singleton swatch cards and sustainability certification badges', () => {
    const singletonAndEco = searchCardElement(`
      <div class="s-color-swatch-container">
        <span data-csa-c-content-id="color-swatch-link"><a aria-label="Black" href="/dp/B0SRCHVAR1"></a></span>
      </div>
      <div class="a-section">
        <a aria-label="Learn more about Global Recycled Standard" href="/climate">+2 more certifications</a>
      </div>
    `);
    const parsed = parseAmazonSearchCard(
      singletonAndEco,
      'https://www.amazon.com/s?k=tee',
    );
    expect(parsed?.variations).toBeUndefined();

    // Category card extraction parity
    const catCard = searchCardElement(`
      <div class="s-color-swatch-container">
        <span data-csa-c-content-id="color-swatch-link"><a aria-label="Crimson" href="/dp/B0SRCHVAR1"></a></span>
        <span data-csa-c-content-id="color-swatch-link"><a aria-label="Slate" href="/dp/B0SRCHVAR2"></a></span>
      </div>
    `);
    const parsedCategory = parseAmazonCategoryCard(
      catCard,
      'https://www.amazon.com/gp/bestsellers/apparel',
    );
    expect(parsedCategory?.variations).toBe('2 (Color: Crimson, Slate)');
  });
});

describe('Merge, Dexie persistence & background PDP enrichment (SAD-357 + SAD-352)', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.snapshots.clear();
    await db.history.clear();
    await db.settings.clear();
  });

  it('upgrades search swatch hints when PDP detail merges in dedup, Dexie addProducts, and enrichSavedProduct', async () => {
    const searchItem: ScrapedAmazonProduct = {
      asin: 'B0UPGRADE1',
      url: 'https://www.amazon.com/dp/B0UPGRADE1',
      title: 'Travel Bottle',
      price: 24.99,
      currency: 'USD',
      variations: '4 (Color: Black, Blue, +2 more)',
      source: 'search',
    };

    const detailHtml = `<!doctype html><html><body>
      <h1 id="productTitle">Travel Bottle Insulated</h1>
      <input id="ASIN" value="B0UPGRADE1" />
      <div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price"><span class="a-offscreen">$24.99</span></span>
      </div>
      <script type="text/javascript">
        P.register('twister-js-init-dpx-data', function() {
          return {
            "dimensions": ["size_name", "color_name"],
            "variationDisplayLabels": {"size_name": "Size", "color_name": "Color"},
            "variationValues": {
              "size_name": ["18 oz", "32 oz"],
              "color_name": ["Black", "Blue", "Sage", "Sand"]
            },
            "num_total_variations": 8
          };
        });
      </script>
      <div id="productDetails_expanderTables_depthLeftSections">
        <table class="a-keyvalue prodDetTable">
          <tr><th>Item Weight</th><td>0.42 Kilograms</td></tr>
        </table>
      </div>
    </body></html>`;

    // 1. Offscreen HTML parser check
    const offscreen = parsePdpHtml(
      detailHtml,
      'https://www.amazon.com/dp/B0UPGRADE1',
      'B0UPGRADE1',
    );
    expect(offscreen.ok).toBe(true);
    if (!offscreen.ok) throw new Error('Expected offscreen ok');
    expect(offscreen.product.variations).toBe(
      '8 (Size: 18 oz, 32 oz; Color: Black, Blue, Sage, Sand)',
    );
    expect(offscreen.product.weight).toBe('0.42 kg');

    // 2. One-click quick save -> background PDP enrichment upgrade
    await saveQuickProduct({
      product: searchItem,
      sessionKey: 'sess-upgrade',
      jobId: 'job-upgrade-1',
    });

    const beforeRow = await db.products
      .where('[sessionKey+asin]')
      .equals(['sess-upgrade', 'B0UPGRADE1'])
      .first();
    expect(beforeRow?.variations).toBe('4 (Color: Black, Blue, +2 more)');
    expect(beforeRow?.weight).toBeUndefined();
    expect(collectMissingDetailFields(beforeRow!)).toContain('weight');

    const result = await enrichSavedProduct(
      {
        jobId: 'job-upgrade-1',
        asin: 'B0UPGRADE1',
        productUrl: 'https://www.amazon.com/dp/B0UPGRADE1',
        sessionKey: 'sess-upgrade',
      },
      {
        fetchOptions: {
          hasHostPermission: async () => true,
          fetchImpl: async () =>
            new Response(detailHtml, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }),
        },
        parse: async (html, url, expectedAsin) =>
          parsePdpHtml(html, url, expectedAsin),
      },
    );

    expect(result.status).toBe('complete');
    expect(result.fieldsChanged).toContain('variations');
    expect(result.fieldsChanged).toContain('weight');

    const enrichedRow = await db.products
      .where('[sessionKey+asin]')
      .equals(['sess-upgrade', 'B0UPGRADE1'])
      .first();
    expect(enrichedRow?.variations).toBe(
      '8 (Size: 18 oz, 32 oz; Color: Black, Blue, Sage, Sand)',
    );
    expect(enrichedRow?.weight).toBe('0.42 kg');
    expect(collectMissingDetailFields(enrichedRow!)).not.toContain('variations');
    expect(collectMissingDetailFields(enrichedRow!)).not.toContain('weight');

    // 3. Dedup & addProducts also upgrade search swatch hints from detail and never erase with undefined
    const copy = { ...searchItem };
    mergeScrapedProductFields(copy, offscreen.product);
    expect(copy.variations).toBe(
      '8 (Size: 18 oz, 32 oz; Color: Black, Blue, Sage, Sand)',
    );
    expect(copy.weight).toBe('0.42 kg');

    await addProducts([searchItem], 'sess-batch');
    await addProducts([offscreen.product], 'sess-batch');
    const batchStored = await db.products
      .where('[sessionKey+asin]')
      .equals(['sess-batch', 'B0UPGRADE1'])
      .first();
    expect(batchStored?.variations).toBe(
      '8 (Size: 18 oz, 32 oz; Color: Black, Blue, Sage, Sand)',
    );
    expect(batchStored?.weight).toBe('0.42 kg');
  });
});

describe('Sorting by physical mass and variation count (SAD-357)', () => {
  it('sorts weights accurately across mg, g, kg, oz, lb, and compound lb+oz with missing last', () => {
    expect(parseSortableWeightGrams('250 mg')).toBeCloseTo(0.25, 4);
    expect(parseSortableWeightGrams('9.12 oz')).toBeCloseTo(258.5477, 3);
    expect(parseSortableWeightGrams('1 lb 4 oz')).toBeCloseTo(566.9905, 3);

    const items = [
      makeProduct('B0WGHTNONE', { weight: undefined }),
      makeProduct('B0WGHTLBS1', { weight: '1.73 lbs' }), // ~784.7 g
      makeProduct('B0WGHTGRAM', { weight: '0.31 g' }), // 0.31 g
      makeProduct('B0WGHTCOMP', { weight: '1 lb 4 oz' }), // ~567.0 g
      makeProduct('B0WGHTKG01', { weight: '0.19 kg' }), // 190 g
      makeProduct('B0WGHTMG01', { weight: '250 mg' }), // 0.25 g
      makeProduct('B0WGHT00OZ', { weight: '9.12 oz' }), // ~258.5 g
    ];

    const asc = sortProducts(items, [{ id: 'weight', desc: false }]);
    expect(asc.map((p) => p.asin)).toEqual([
      'B0WGHTMG01',
      'B0WGHTGRAM',
      'B0WGHTKG01',
      'B0WGHT00OZ',
      'B0WGHTCOMP',
      'B0WGHTLBS1',
      'B0WGHTNONE',
    ]);

    const desc = sortProducts(items, [{ id: 'weight', desc: true }]);
    expect(desc.map((p) => p.asin)).toEqual([
      'B0WGHTLBS1',
      'B0WGHTCOMP',
      'B0WGHT00OZ',
      'B0WGHTKG01',
      'B0WGHTGRAM',
      'B0WGHTMG01',
      'B0WGHTNONE',
    ]);
  });

  it('sorts variations numerically by total count with missing last', () => {
    expect(parseSortableVariationCount('88 (Size: 64GB, 128GB)')).toBe(88);
    expect(parseSortableVariationCount(null)).toBeNull();

    const items = [
      makeProduct('B0VARNONE0', { variations: null }),
      makeProduct('B0VAR00010', { variations: '10 (Size: S, M)' }),
      makeProduct('B0VAR00002', { variations: '2 (Size: S, M)' }),
      makeProduct('B0VAR00088', { variations: '88 (Size: 64GB, 128GB)' }),
    ];

    const asc = sortProducts(items, [{ id: 'variations', desc: false }]);
    expect(asc.map((p) => p.asin)).toEqual([
      'B0VAR00002',
      'B0VAR00010',
      'B0VAR00088',
      'B0VARNONE0',
    ]);

    const desc = sortProducts(items, [{ id: 'variations', desc: true }]);
    expect(desc.map((p) => p.asin)).toEqual([
      'B0VAR00088',
      'B0VAR00010',
      'B0VAR00002',
      'B0VARNONE0',
    ]);
  });
});

describe('Preview Table, CellExpandModal (SAD-358), Settings & Exports', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.settings.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders populated Variations & Weight, keeps absent cells blank with zero dead expand buttons, and expands full Variations in CellExpandModal', async () => {
    const fullVariations =
      '10 (Size: 1 Pack, 6 Pack; Color: Black, Cobalt Blue, Miami, Purple, Red)';
    await db.products.bulkAdd([
      makeProduct('B0FULLROW1', {
        variations: fullVariations,
        weight: '0.19 kg',
      }),
      makeProduct('B0EMPTYRW2', {
        variations: undefined,
        weight: undefined,
      }),
    ]);

    render(<ProductTable fullHeight sessionKey="sess-sad-357" />);

    await waitFor(() => {
      expect(screen.getByTestId('product-variations-B0FULLROW1').textContent).toBe(
        fullVariations,
      );
      expect(screen.getByTestId('product-weight-B0FULLROW1').textContent).toBe(
        '0.19 kg',
      );
    });

    // Empty row: no text span AND only 1 expand button in the whole column (no dead affordance on B0EMPTYRW2)
    expect(screen.queryByTestId('product-variations-B0EMPTYRW2')).toBeNull();
    expect(screen.queryByTestId('product-weight-B0EMPTYRW2')).toBeNull();
    const expandButtons = screen.getAllByTestId('cell-expand-button-variations');
    expect(expandButtons).toHaveLength(1);

    // Click expand -> opens CellExpandModal with count pill + per-dimension bulleted breakdown
    fireEvent.click(expandButtons[0]!);
    const dialog = await screen.findByRole('dialog');
    const breakdown = within(dialog).getByTestId('cell-expand-variations-list');
    expect(breakdown.textContent).toContain('10 total variations');
    expect(breakdown.textContent).toContain('Size:');
    expect(breakdown.textContent).toContain('1 Pack, 6 Pack');
    expect(breakdown.textContent).toContain('Color:');
    expect(breakdown.textContent).toContain(
      'Black, Cobalt Blue, Miami, Purple, Red',
    );
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);

    // Dismiss via Escape -> table state preserved, then global text filter matches both Variations & Weight
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    const filterInput = screen.getByPlaceholderText(/filter/i);
    fireEvent.change(filterInput, { target: { value: 'Cobalt Blue' } });
    await waitFor(() => {
      expect(screen.getByText('Product B0FULLROW1')).toBeTruthy();
      expect(screen.queryByText('Product B0EMPTYRW2')).toBeNull();
    });

    fireEvent.change(filterInput, { target: { value: '0.19 kg' } });
    await waitFor(() => {
      expect(screen.getByText('Product B0FULLROW1')).toBeTruthy();
      expect(screen.queryByText('Product B0EMPTYRW2')).toBeNull();
    });

    fireEvent.change(filterInput, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByText('Product B0EMPTYRW2')).toBeTruthy();
    });
  });

  it('wires Settings > DATA FIELDS toggles and round-trips CSV, TSV, and XLSX with blank empty cells', async () => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
    render(
      <StrictMode>
        <Header />
        <SettingsOverlay />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByText('DATA FIELDS', {}, { timeout: 3000 });

    const varToggle = screen.getByLabelText('Variations') as HTMLInputElement;
    const weightToggle = screen.getByLabelText('Weight') as HTMLInputElement;
    expect(varToggle.checked).toBe(true);
    expect(weightToggle.checked).toBe(true);

    await updateSettings({
      enabledFields: {
        ...DEFAULT_ENABLED_FIELDS,
        variations: false,
      },
    });
    expect((await getSettings()).enabledFields.variations).toBe(false);
    expect(
      getExportColumnsFromSettings((await getSettings()).enabledFields),
    ).not.toContain('Variations');
    expect(
      getExportColumnsFromSettings((await getSettings()).enabledFields),
    ).toContain('Weight');

    vi.unstubAllGlobals();

    const exportRows: Product[] = [
      makeProduct('B0EXPROW01', {
        variations: '4 (Size: S, M; Color: Black, White)',
        weight: '1.73 lbs',
      }),
      makeProduct('B0EXPROW02', {
        variations: undefined,
        weight: undefined,
      }),
    ];

    // CSV round-trip
    const csv = buildCSVContent(exportRows, DEFAULT_VISIBLE_COLUMNS, false);
    const csvWorkbook = XLSX.read(csv, { type: 'string' });
    const csvParsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      csvWorkbook.Sheets[csvWorkbook.SheetNames[0]!]!,
      { defval: '' },
    );
    expect(csvParsed[0]).toMatchObject({
      ASIN: 'B0EXPROW01',
      Variations: '4 (Size: S, M; Color: Black, White)',
      Weight: '1.73 lbs',
    });
    expect(csvParsed[1]).toMatchObject({
      ASIN: 'B0EXPROW02',
      Variations: '',
      Weight: '',
    });

    // Clipboard TSV round-trip
    const tsv = buildClipboardTSV(exportRows, DEFAULT_VISIBLE_COLUMNS);
    const tsvLines = tsv.split('\n');
    expect(tsvLines[0]).toContain('Variations\tWeight');
    expect(tsvLines[1]).toContain(
      '4 (Size: S, M; Color: Black, White)\t1.73 lbs',
    );

    // Excel (.xlsx) round-trip
    const xlsxBytes = await buildExcelWorkbookBuffer(
      exportRows,
      DEFAULT_VISIBLE_COLUMNS,
      { embedImages: 'never' },
    );
    const wb = XLSX.read(xlsxBytes, { type: 'array' });
    const sheet = wb.Sheets['Products']!;
    const xlsxParsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
    });
    expect(xlsxParsed[0]).toMatchObject({
      ASIN: 'B0EXPROW01',
      Variations: '4 (Size: S, M; Color: Black, White)',
      Weight: '1.73 lbs',
    });
    expect(xlsxParsed[1]).toMatchObject({
      ASIN: 'B0EXPROW02',
      Variations: '',
      Weight: '',
    });
  });
});
