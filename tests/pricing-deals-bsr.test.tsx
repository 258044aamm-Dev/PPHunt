import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { db } from '@/lib/db/database';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import { parseProductDetail } from '@/lib/scraper/product-detail';
import { buildCSVContent } from '@/lib/export/csv';
import { buildClipboardTSV } from '@/engines/amazon/export/clipboard';
import { buildExcelWorkbookBuffer } from '@/lib/export/excel';
import { DEFAULT_VISIBLE_COLUMNS } from '@/lib/export/types';
import type { Product } from '@/types/product';

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

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('Product pricing, deal badges, list price separation, BSR, and market intelligence (SAD-140)', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
  });

  it('extracts discount percentage, deal labels, list price, selling price, and market signals while never confusing struck-through prices with selling price', () => {
    const html = `
      <div class="s-main-slot">
        <!-- Card 1: Struck-through list price appears BEFORE selling price in DOM + Limited-time deal + -68% + coupon + 10K+ bought -->
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

        <!-- Card 2: Regular full-price product with NO discount, NO list price, and NO deal badge -->
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

    const products = parseSearchResults(
      createDoc(html),
      'https://www.amazon.com/s?k=earbuds'
    );
    expect(products).toHaveLength(2);

    const dealProduct = products.find((p) => p.asin === 'B0DEAL0001')!;
    expect(dealProduct.price).toBe(31.99);
    expect(dealProduct.listPrice).toBe(99.99);
    expect(dealProduct.discountPercentage).toBe('68% off');
    expect(dealProduct.dealBadge).toBe('Limited-time deal');
    expect(dealProduct.pastMonthSales).toBe('10K+ bought in past month');
    expect(dealProduct.coupon).toBe('Save 15% with coupon');
    expect(dealProduct.badge).toBe("Amazon's Choice");
    expect(dealProduct.delivery).toBe('FREE delivery Tomorrow, Oct 17');

    // Verify regular product does NOT invent or calculate listPrice, discountPercentage, or dealBadge
    const regularProduct = products.find((p) => p.asin === 'B0REG00002')!;
    expect(regularProduct.price).toBe(14.99);
    expect(regularProduct.listPrice).toBeUndefined();
    expect(regularProduct.discountPercentage).toBeUndefined();
    expect(regularProduct.dealBadge).toBeUndefined();
  });

  it('extracts Best Sellers Rank (#5 in Electronics), deal badge, list price, and discount on product detail and Best Sellers pages', () => {
    const detailHtml = `
      <html>
        <head>
          <link rel="canonical" href="https://www.amazon.com/dp/B0BSRDET01" />
        </head>
        <body>
          <div id="centerCol">
            <h1 id="title"><span id="productTitle">Bose QuietComfort Ultra Headphones</span></h1>
            <a id="bylineInfo">Visit the Bose Store</a>
            <div><span>5K+ bought in past month</span></div>
            <div id="dealBadge_feature_div">
              <span class="dealBadgeText">Limited-time deal</span>
            </div>
            <div id="corePriceDisplay_desktop_feature_div">
              <span class="a-size-large a-color-price savingPriceOverride aok-align-center reinventPriceSavingsPercentageMargin savingsPercentage">-23%</span>
              <span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay">
                <span class="a-offscreen">$329.00</span>
              </span>
              <span class="basisPrice">
                List Price:
                <span class="a-price a-text-price" data-a-strike="true">
                  <span class="a-offscreen">$429.00</span>
                </span>
              </span>
            </div>
            <div id="couponBadgeRegularVpc">
              <span>Save $20.00 with coupon</span>
            </div>
            <div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">
              <span>FREE delivery Mon, Oct 19</span>
            </div>
          </div>
          <img id="landingImage" src="https://m.media-amazon.com/images/I/71bose._AC_SL1500_.jpg" />
          <table id="productDetails_detailBullets_sections1">
            <tbody>
              <tr>
                <th>ASIN</th>
                <td>B0BSRDET01</td>
              </tr>
              <tr>
                <th>Best Sellers Rank</th>
                <td>
                  <span>#5 in Electronics (See Top 100 in Electronics)</span>
                  <span>#1 in Over-Ear Headphones</span>
                </td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `;

    const detail = parseProductDetail(
      createDoc(detailHtml),
      'https://www.amazon.com/dp/B0BSRDET01'
    );
    expect(detail).not.toBeNull();
    expect(detail?.price).toBe(329);
    expect(detail?.listPrice).toBe(429);
    expect(detail?.discountPercentage).toBe('23% off');
    expect(detail?.dealBadge).toBe('Limited-time deal');
    expect(detail?.bestSellersRank).toBe(
      '#5 in Electronics (#1 in Over-Ear Headphones)'
    );
    expect(detail?.pastMonthSales).toBe('5K+ bought in past month');
    expect(detail?.coupon).toBe('Save $20.00 with coupon');
    expect(detail?.delivery).toBe('FREE delivery Mon, Oct 19');

    // Best Sellers page with category banner + card rank badge
    const bestSellersHtml = `
      <div>
        <h1>Best Sellers in Electronics</h1>
        <div id="gridItemRoot" class="zg-grid-general-faceout" data-asin="B0BSRCAT01">
          <span class="zg-bdg-text">#1</span>
          <a href="/Apple-AirTag/dp/B0BSRCAT01">
            <div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Apple AirTag 4 Pack</div>
          </a>
          <span class="a-price" data-a-strike="true"><span class="a-offscreen">$99.00</span></span>
          <span class="a-price"><span class="a-offscreen">$79.99</span></span>
          <span class="savingsPercentage">19% off</span>
          <img src="https://m.media-amazon.com/images/I/71airtag._AC_UL320_.jpg" />
        </div>
      </div>
    `;

    const catProducts = parseCategoryPage(
      createDoc(bestSellersHtml),
      'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics'
    );
    expect(catProducts).toHaveLength(1);
    expect(catProducts[0]?.price).toBe(79.99);
    expect(catProducts[0]?.listPrice).toBe(99);
    expect(catProducts[0]?.discountPercentage).toBe('19% off');
    expect(catProducts[0]?.bestSellersRank).toBe('#1 in Electronics');
  });

  it('renders pricing, deal, BSR, and market columns in PreviewTable and includes them in CSV and XLSX exports', async () => {
    const sampleProducts: Product[] = [
      {
        id: 1,
        asin: 'B0PRV00001',
        title: 'Discounted Deal Product',
        price: 31.99,
        listPrice: 99.99,
        discountPercentage: '68% off',
        dealBadge: 'Limited-time deal',
        currency: 'USD',
        rating: 4.8,
        reviewCount: 4120,
        bestSellersRank: '#5 in Electronics',
        pastMonthSales: '10K+ bought in past month',
        coupon: 'Save 15% with coupon',
        badge: "Amazon's Choice",
        delivery: 'FREE delivery Tomorrow',
        imageUrl: 'https://m.media-amazon.com/images/I/deal1.jpg',
        url: 'https://www.amazon.com/dp/B0PRV00001',
        isSponsored: false,
        isPrime: true,
        brand: 'Anker',
        seller: 'AnkerDirect',
        availability: 'In Stock',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T13:00:00.000Z',
        sessionKey: 'session-sad140',
      },
      {
        id: 2,
        asin: 'B0PRV00002',
        title: 'No Discount Regular Product',
        price: 24.5,
        listPrice: null,
        discountPercentage: null,
        dealBadge: null,
        currency: 'USD',
        rating: 4.3,
        reviewCount: 190,
        bestSellersRank: null,
        pastMonthSales: null,
        coupon: null,
        badge: null,
        delivery: null,
        imageUrl: 'https://m.media-amazon.com/images/I/reg2.jpg',
        url: 'https://www.amazon.com/dp/B0PRV00002',
        isSponsored: false,
        isPrime: true,
        brand: 'Basics',
        seller: 'Amazon.com',
        availability: 'In Stock',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:59:00.000Z',
        sessionKey: 'session-sad140',
      },
    ];

    await db.products.bulkAdd(sampleProducts);
    const { unmount } = render(
      <ProductTable fullHeight sessionKey="session-sad140" />
    );

    await waitFor(() => {
      expect(screen.getByTestId('product-price-B0PRV00001').textContent).toBe(
        '$31.99'
      );
      expect(
        screen.getByTestId('product-list-price-B0PRV00001').textContent
      ).toBe('$99.99');
      expect(
        screen.getByTestId('product-discount-B0PRV00001').textContent
      ).toBe('68% off');
      expect(screen.getByTestId('product-deal-B0PRV00001').textContent).toBe(
        'Limited-time deal'
      );
      expect(screen.getByTestId('product-bsr-B0PRV00001').textContent).toBe(
        '#5 in Electronics'
      );
      expect(
        screen.getByTestId('product-monthly-sales-B0PRV00001').textContent
      ).toBe('10K+ bought in past month');
      expect(screen.getByTestId('product-coupon-B0PRV00001').textContent).toBe(
        'Save 15% with coupon'
      );
      expect(screen.getByTestId('product-badge-B0PRV00001').textContent).toBe(
        "Amazon's Choice"
      );
      expect(
        screen.getByTestId('product-delivery-B0PRV00001').textContent
      ).toBe('FREE delivery Tomorrow');
    });

    // SAD-348: the no-discount product's Discount/Deal/Coupon/Badge render "No",
    // its other optional fields render blank (no dash, no testid), and its
    // populated core Price still renders.
    for (const prefix of [
      'product-list-price-',
      'product-bsr-',
      'product-monthly-sales-',
      'product-delivery-',
    ]) {
      expect(screen.queryByTestId(`${prefix}B0PRV00002`)).toBeNull();
    }
    const emptyRow = screen
      .getByTestId('product-price-B0PRV00002')
      .closest('tr');
    const headerTexts = Array.from(
      document.querySelectorAll('thead th')
    ).map((th) => th.textContent ?? '');
    const emptyCells = emptyRow?.querySelectorAll('td');
    for (const header of ['Discount', 'Deal', 'Coupon', 'Badge']) {
      const idx = headerTexts.findIndex((h) => h.includes(header));
      expect(emptyCells?.[idx]?.textContent).toBe('No');
    }
    expect(screen.getByTestId('product-price-B0PRV00002').textContent).toBe(
      '$24.50'
    );
    expect(emptyRow?.textContent).not.toContain('—');

    unmount();

    // Verify CSV export contains all new headers and values while leaving missing values empty
    const csv = buildCSVContent(sampleProducts, DEFAULT_VISIBLE_COLUMNS, false);
    const lines = csv.split('\n');
    expect(lines[0]).toContain(
      'Price,List Price,Discount,Deal,Currency,Rating,Reviews,Best Sellers Rank,Monthly Sales,Coupon,Badge,Delivery'
    );
    expect(lines[1]).toContain(
      '31.99,99.99,68% off,Limited-time deal,USD,4.8,4120,#5 in Electronics,10K+ bought in past month,Save 15% with coupon,Amazon\'s Choice,FREE delivery Tomorrow'
    );
    expect(lines[2]).toContain('24.5,,No,No,USD,4.3,190,,,No,No,');

    // SAD-348: clipboard TSV likewise leaves missing optional fields empty
    const tsv = buildClipboardTSV(sampleProducts, DEFAULT_VISIBLE_COLUMNS);
    const tsvLines = tsv.split('\n');
    expect(tsvLines[2]).toContain('24.5\t\tNo\tNo\tUSD\t4.3\t190\t\t\tNo\tNo\t');
    expect(tsv).not.toContain('—');

    // Verify XLSX export preserves numeric Price and List Price and all promotional/BSR strings
    const xlsxBytes = await buildExcelWorkbookBuffer(
      sampleProducts,
      DEFAULT_VISIBLE_COLUMNS,
      {
        embedImages: 'always', // SAD-192: explicit, independent of the default
        fetchImage: async () => null,
      }
    );
    const wb = XLSX.read(xlsxBytes, { type: 'array' });
    const productsSheet = wb.Sheets['Products'];
    if (!productsSheet) throw new Error('Products sheet missing from workbook');
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(productsSheet);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ASIN: 'B0PRV00001',
      Price: 31.99,
      'List Price': 99.99,
      Discount: '68% off',
      Deal: 'Limited-time deal',
      'Best Sellers Rank': '#5 in Electronics',
      'Monthly Sales': '10K+ bought in past month',
      Coupon: 'Save 15% with coupon',
      Badge: "Amazon's Choice",
      Delivery: 'FREE delivery Tomorrow',
    });
    expect(rows[1]).toMatchObject({
      ASIN: 'B0PRV00002',
      Price: 24.5,
      'List Price': '',
      Discount: 'No',
      Deal: 'No',
      'Best Sellers Rank': '',
    });
  });
});
