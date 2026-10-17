import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { db } from '@/lib/db/database';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { buildCSVContent } from '@/lib/export/csv';
import { buildExcelWorkbookBuffer } from '@/lib/export/excel';
import { DEFAULT_VISIBLE_COLUMNS } from '@/lib/export/types';
import type { Product } from '@/types/product';

// Mock @tanstack/react-virtual so all rows render in jsdom without physical layout measurements
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

describe('Preview pane images, dynamic row numbering (#), and CSV/XLSX image exports (SAD-139)', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('extracts product images from div-based /deals and category cards where link or data-asin is in a nested child container', () => {
    const dealsHtml = `
      <div class="deals-grid">
        <div class="deal-card-outer">
          <div class="deal-image-col">
            <img class="deal-badge" src="https://m.media-amazon.com/images/G/01/badges/prime-badge-1x1.gif" width="1" height="1" alt="" />
            <picture>
              <source srcset="https://m.media-amazon.com/images/I/71dealImg1._AC_SL1000_.jpg 1x, https://m.media-amazon.com/images/I/71dealImg1._AC_SL1500_.jpg 2x" />
              <img data-lazy-src="https://m.media-amazon.com/images/I/71dealImg1._AC_SL500_.jpg" alt="Anker Prime 20,000mAh Power Bank" />
            </picture>
          </div>
          <div class="deal-info-col">
            <div class="deal-title-wrapper">
              <a href="/Anker-Power-Bank/dp/B09V3KXJP1/ref=dlx_deals">
                <span>Anker Prime 20,000mAh Power Bank</span>
              </a>
            </div>
            <div class="deal-price-wrapper">
              <span class="a-price"><span class="a-offscreen">$89.99</span></span>
            </div>
          </div>
        </div>

        <div class="deal-card-outer">
          <div class="deal-image-col">
            <img data-a-hires="https://m.media-amazon.com/images/I/81dealImg2._AC_SL1500_.jpg" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Sony WH-1000XM5 Headphones" />
          </div>
          <div class="deal-info-col" data-asin="B09V3KXJP2">
            <a href="/Sony-XM5/dp/B09V3KXJP2">
              <h3>Sony WH-1000XM5 Headphones</h3>
            </a>
            <span class="a-price"><span class="a-offscreen">$298.00</span></span>
          </div>
        </div>
      </div>
    `;

    const doc = createDoc(dealsHtml);
    const categoryProducts = parseCategoryPage(
      doc,
      'https://www.amazon.com/deals'
    );
    expect(categoryProducts).toHaveLength(2);
    const catProd1 = categoryProducts.find((p) => p.asin === 'B09V3KXJP1');
    const catProd2 = categoryProducts.find((p) => p.asin === 'B09V3KXJP2');
    expect(catProd1?.imageUrl).toBe(
      'https://m.media-amazon.com/images/I/71dealImg1._AC_SL1500_.jpg'
    );
    expect(catProd2?.imageUrl).toBe(
      'https://m.media-amazon.com/images/I/81dealImg2._AC_SL1500_.jpg'
    );

    const searchProducts = parseSearchResults(
      createDoc(dealsHtml),
      'https://www.amazon.com/deals'
    );
    expect(searchProducts).toHaveLength(2);
    const searchProd1 = searchProducts.find((p) => p.asin === 'B09V3KXJP1');
    const searchProd2 = searchProducts.find((p) => p.asin === 'B09V3KXJP2');
    expect(searchProd1?.imageUrl).toBe(
      'https://m.media-amazon.com/images/I/71dealImg1._AC_SL1500_.jpg'
    );
    expect(searchProd2?.imageUrl).toBe(
      'https://m.media-amazon.com/images/I/81dealImg2._AC_SL1500_.jpg'
    );
  });

  it('renders product thumbnails in the Preview table and falls back cleanly on image error or missing URL', async () => {
    await db.products.bulkAdd([
      {
        asin: 'B0IMGVALID',
        title: 'Valid Image Product',
        price: 49.99,
        currency: 'USD',
        rating: 4.7,
        reviewCount: 320,
        brand: 'Anker',
        seller: 'AnkerDirect',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: 'https://m.media-amazon.com/images/I/71valid._AC_UL320_.jpg',
        url: 'https://www.amazon.com/dp/B0IMGVALID',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:02:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=anker',
        sessionKey: 'session-img',
      },
      {
        asin: 'B0IMGNONE1',
        title: 'Missing Image Product',
        price: 19.99,
        currency: 'USD',
        rating: 4.2,
        reviewCount: 85,
        brand: 'Basics',
        seller: 'Amazon.com',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: null,
        url: 'https://www.amazon.com/dp/B0IMGNONE1',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:01:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=anker',
        sessionKey: 'session-img',
      },
    ]);

    render(<ProductTable fullHeight sessionKey="session-img" />);

    const imgEl = (await screen.findByTestId(
      'product-image-B0IMGVALID'
    )) as HTMLImageElement;
    expect(imgEl).toBeTruthy();
    expect(imgEl.getAttribute('src')).toBe(
      'https://m.media-amazon.com/images/I/71valid._AC_UL320_.jpg'
    );
    expect(imgEl.getAttribute('referrerpolicy')).toBe('no-referrer');

    const placeholderEl = await screen.findByTestId(
      'product-image-placeholder-B0IMGNONE1'
    );
    expect(placeholderEl).toBeTruthy();

    // Simulate network load error on the valid image and verify fallback placeholder renders
    fireEvent.error(imgEl);
    await waitFor(() => {
      expect(
        screen.getByTestId('product-image-placeholder-B0IMGVALID')
      ).toBeTruthy();
    });
  });

  it('displays 1-based # row numbers and keeps them accurate when rows are added, removed, filtered, or sorted', async () => {
    const id1 = await db.products.add({
      asin: 'B0ROW00001',
      title: 'Charlie Product',
      price: 30,
      currency: 'USD',
      rating: 4.5,
      reviewCount: 100,
      brand: 'BrandC',
      seller: 'Amazon',
      availability: 'In Stock',
      isSponsored: false,
      isPrime: true,
      imageUrl: 'https://m.media-amazon.com/images/I/charlie.jpg',
      url: 'https://www.amazon.com/dp/B0ROW00001',
      description: null,
      features: [],
      source: 'search',
      collectedAt: '2026-10-16T12:03:00.000Z',
      pageUrl: 'https://www.amazon.com/s?k=test',
      sessionKey: 'session-rows',
    });
    const id2 = await db.products.add({
      asin: 'B0ROW00002',
      title: 'Alpha Product',
      price: 10,
      currency: 'USD',
      rating: 4.8,
      reviewCount: 200,
      brand: 'BrandA',
      seller: 'Amazon',
      availability: 'In Stock',
      isSponsored: false,
      isPrime: true,
      imageUrl: 'https://m.media-amazon.com/images/I/alpha.jpg',
      url: 'https://www.amazon.com/dp/B0ROW00002',
      description: null,
      features: [],
      source: 'search',
      collectedAt: '2026-10-16T12:02:00.000Z',
      pageUrl: 'https://www.amazon.com/s?k=test',
      sessionKey: 'session-rows',
    });

    render(<ProductTable fullHeight sessionKey="session-rows" />);

    await waitFor(() => {
      const nums = screen
        .getAllByTestId('table-row-number')
        .map((el) => el.textContent);
      expect(nums).toEqual(['1', '2']);
    });

    // Add a 3rd row and verify row numbers become 1, 2, 3
    await db.products.add({
      asin: 'B0ROW00003',
      title: 'Bravo Product',
      price: 20,
      currency: 'USD',
      rating: 4.1,
      reviewCount: 50,
      brand: 'BrandB',
      seller: 'Amazon',
      availability: 'In Stock',
      isSponsored: false,
      isPrime: false,
      imageUrl: 'https://m.media-amazon.com/images/I/bravo.jpg',
      url: 'https://www.amazon.com/dp/B0ROW00003',
      description: null,
      features: [],
      source: 'search',
      collectedAt: '2026-10-16T12:01:00.000Z',
      pageUrl: 'https://www.amazon.com/s?k=test',
      sessionKey: 'session-rows',
    });

    await waitFor(() => {
      const nums = screen
        .getAllByTestId('table-row-number')
        .map((el) => el.textContent);
      expect(nums).toEqual(['1', '2', '3']);
    });

    // Sort by Title ascending -> Alpha (1), Bravo (2), Charlie (3)
    const titleHeader = screen.getByText('Title');
    fireEvent.click(titleHeader);

    await waitFor(() => {
      const bodyRows = Array.from(document.querySelectorAll('tbody tr'));
      expect(bodyRows[0]?.textContent).toContain('Alpha Product');
      expect(bodyRows[1]?.textContent).toContain('Bravo Product');
      expect(bodyRows[2]?.textContent).toContain('Charlie Product');
      const nums = screen
        .getAllByTestId('table-row-number')
        .map((el) => el.textContent);
      expect(nums).toEqual(['1', '2', '3']);
    });

    // Filter to "Bravo" and verify the single remaining row is numbered 1
    const searchInput = screen.getByPlaceholderText(/filter/i);
    fireEvent.change(searchInput, { target: { value: 'Bravo' } });

    await waitFor(() => {
      const nums = screen
        .getAllByTestId('table-row-number')
        .map((el) => el.textContent);
      expect(nums).toEqual(['1']);
    });

    // Clear filter and delete one row (id1); verify remaining 2 rows are numbered 1, 2
    fireEvent.change(searchInput, { target: { value: '' } });
    await db.products.delete(id1 as number);
    expect(id2).toBeDefined();

    await waitFor(() => {
      const nums = screen
        .getAllByTestId('table-row-number')
        .map((el) => el.textContent);
      expect(nums).toEqual(['1', '2']);
    });
  });

  it('includes image URLs in CSV exports and embeds images with automatic URL fallback in XLSX exports', async () => {
    const sampleProducts: Product[] = [
      {
        sessionKey: 'session-export',
        id: 1,
        asin: 'B0EX000001',
        title: 'Embedded Thumbnail Product',
        price: 59.99,
        currency: 'USD',
        rating: 4.9,
        reviewCount: 512,
        brand: 'Logitech',
        seller: 'Amazon.com',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: 'https://m.media-amazon.com/images/I/embedded.png',
        url: 'https://www.amazon.com/dp/B0EX000001',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:00:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=mouse',
      },
      {
        sessionKey: 'session-export',
        id: 2,
        asin: 'B0EX000002',
        title: 'Fallback URL Product (Network Error)',
        price: 29.99,
        currency: 'USD',
        rating: 4.4,
        reviewCount: 128,
        brand: 'Keychron',
        seller: 'Keychron',
        availability: 'In Stock',
        isSponsored: true,
        isPrime: false,
        imageUrl: 'https://m.media-amazon.com/images/I/unreachable.jpg',
        url: 'https://www.amazon.com/dp/B0EX000002',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:01:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=mouse',
      },
      {
        sessionKey: 'session-export',
        id: 3,
        asin: 'B0EX000003',
        title: 'Invalid Image URL Product',
        price: 14.99,
        currency: 'USD',
        rating: 4.0,
        reviewCount: 42,
        brand: 'Generic',
        seller: 'ThirdParty',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: 'javascript:alert(1)' as unknown as string,
        url: 'https://www.amazon.com/dp/B0EX000003',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:02:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=mouse',
      },
    ];

    // 1. Verify CSV export includes Image column with valid URLs and empty string for invalid URL
    const csv = buildCSVContent(sampleProducts, DEFAULT_VISIBLE_COLUMNS, false);
    const csvLines = csv.split('\n');
    expect(csvLines[0]).toContain('Image');
    expect(csvLines[1]).toContain(
      'https://m.media-amazon.com/images/I/embedded.png'
    );
    expect(csvLines[2]).toContain(
      'https://m.media-amazon.com/images/I/unreachable.jpg'
    );
    expect(csvLines[3]).not.toContain('javascript:alert(1)');

    // 2. Verify XLSX export embeds the first image into /xl/media/image1.png + /xl/drawings/drawing1.xml,
    // falls back to URL text for the unreachable second image, and handles the invalid third URL gracefully
    const pngMagicBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const xlsxBuffer = await buildExcelWorkbookBuffer(
      sampleProducts,
      DEFAULT_VISIBLE_COLUMNS,
      {
        // SAD-192: explicit — this test targets the embed path, not the
        // 'auto' default, so a future default change cannot break it.
        embedImages: 'always',
        fetchImage: async (url) => {
          if (url.includes('embedded.png')) {
            return { bytes: pngMagicBytes, contentType: 'image/png' };
          }
          // Simulate fetch failure on unreachable.jpg
          throw new Error('Network error fetching image');
        },
      }
    );

    const cfb = XLSX.CFB.read(xlsxBuffer, { type: 'array' });
    const mediaEntry = XLSX.CFB.find(cfb, '/xl/media/image1.png');
    const drawingEntry = XLSX.CFB.find(cfb, '/xl/drawings/drawing1.xml');
    const sheetEntry = XLSX.CFB.find(cfb, '/xl/worksheets/sheet1.xml');

    expect(mediaEntry).toBeTruthy();
    expect(drawingEntry).toBeTruthy();
    expect(sheetEntry).toBeTruthy();

    const drawingXml = new TextDecoder().decode(
      drawingEntry!.content as Uint8Array
    );
    expect(drawingXml).toContain('r:embed="rId1"');
    expect(drawingXml).toContain(
      'descr="https://m.media-amazon.com/images/I/embedded.png"'
    );

    const sheetXml = new TextDecoder().decode(
      sheetEntry!.content as Uint8Array
    );
    expect(sheetXml).toContain('<drawing r:id="rId1"/>');

    // Verify worksheet cells for fallback and invalid rows
    const wb = XLSX.read(xlsxBuffer, { type: 'array' });
    const productsSheet = wb.Sheets['Products'];
    if (!productsSheet) throw new Error('Products sheet missing from workbook');
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(productsSheet);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.Image).toBe(
      'https://m.media-amazon.com/images/I/embedded.png'
    );
    expect(rows[1]?.Image).toBe(
      'https://m.media-amazon.com/images/I/unreachable.jpg'
    );
    expect(rows[2]?.Image).toBe('');
  });
});
