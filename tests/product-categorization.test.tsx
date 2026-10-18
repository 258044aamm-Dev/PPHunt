import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { db } from '@/lib/db/database';
import { SettingsSchema } from '@/lib/schemas/settings';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import {
  countProductsByListingCategory,
  matchesListingCategoryFilter,
  resolveListingCategory,
  resolveProductPlacements,
} from '@/engines/amazon/utils/listing-category';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import { SettingsOverlay } from '@/entrypoints/sidepanel/components/SettingsOverlay';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { buildCSVContent } from '@/lib/export/csv';
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

describe('Product Categorization, Visual Indicators & Collapsible Section Blocks (SAD-265)', () => {
  beforeEach(async () => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
    useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('classifies Organic, Sponsored, and Recommendation ("People Also Like", "People Also View", "Recently bought and rated") listings and records multi-placement context on duplicates', () => {
    const html = `
      <div class="s-main-slot s-result-list s-search-results sg-row">
        <!-- 1. Sponsored Brand Carousel at top (contains B0DUPL0001 which also appears as Organic in main grid) -->
        <div data-asin="" class="sg-col-20-of-24 s-result-item s-widget" cel_widget_id="multi-card-creative-desktop_loom-desktop-top-slot_0">
          <div data-card-metrics-id="sb-themed-collection-carousel_loom-desktop-top-slot_0">
            <div id="sponsored-brands-top-bar"><span>Sponsored</span></div>
            <ol class="a-carousel">
              <li class="a-carousel-card">
                <div data-asin="B0DUPL0001" class="_c2Itd_asinContainer_1g02Z">
                  <a href="https://www.amazon.com/gp/aw/d/B0DUPL0001">
                    <span class="a-truncate-full a-offscreen">MacBook Air M3 15-inch Laptop</span>
                  </a>
                  <span class="a-price"><span class="a-offscreen">$1,099.00</span></span>
                </div>
              </li>
              <li class="a-carousel-card">
                <div data-asin="B0SPBRND02" class="_c2Itd_asinContainer_1g02Z">
                  <a href="https://www.amazon.com/gp/aw/d/B0SPBRND02">
                    <span class="a-truncate-full a-offscreen">Samsung Galaxy Book4 Pro Laptop</span>
                  </a>
                  <span class="a-price"><span class="a-offscreen">$1,249.99</span></span>
                </div>
              </li>
            </ol>
          </div>
        </div>

        <!-- 2. Main Organic Search Result (B0DUPL0001 — duplicate of Sponsored Brand item) -->
        <div data-asin="B0DUPL0001" data-component-type="s-search-result" class="s-result-item s-asin">
          <div data-cy="title-recipe">
            <h2><span>Apple</span></h2>
            <a class="a-link-normal" href="/dp/B0DUPL0001">
              <h2><span>Apple 2026 MacBook Air 15-inch Laptop with M3 chip</span></h2>
            </a>
          </div>
          <div data-cy="price-recipe">
            <span class="a-price"><span class="a-offscreen">$1,099.00</span></span>
          </div>
        </div>

        <!-- 3. Pure Main Organic Search Result (B0ORGAN001) -->
        <div data-asin="B0ORGAN001" data-component-type="s-search-result" class="s-result-item s-asin">
          <div data-cy="title-recipe">
            <a class="a-link-normal" href="/dp/B0ORGAN001">
              <h2><span>Lenovo ThinkPad E16 Business Laptop</span></h2>
            </a>
          </div>
          <div data-cy="price-recipe">
            <span class="a-price"><span class="a-offscreen">$749.00</span></span>
          </div>
        </div>

        <!-- 4. Recommendation Carousel: "People Also View" -->
        <div data-asin="" class="s-result-item s-widget" data-component-type="s-searchgrid-carousel" cel_widget_id="MAIN-FEATURED_ASINS_LIST-1">
          <h2><span>People Also View</span></h2>
          <div class="a-carousel-container">
            <ol class="a-carousel">
              <li class="a-carousel-card">
                <div data-asin="B0RECOPAV1" class="s-result-item">
                  <div data-cy="title-recipe">
                    <a class="a-link-normal" href="/dp/B0RECOPAV1">
                      <h2><span>HP Pavilion 15.6 FHD Touchscreen Laptop</span></h2>
                    </a>
                  </div>
                  <div data-cy="price-recipe">
                    <span class="a-price"><span class="a-offscreen">$529.99</span></span>
                  </div>
                </div>
              </li>
            </ol>
          </div>
        </div>

        <!-- 5. Recommendation Carousel: "People Also Like" -->
        <div data-asin="" class="s-result-item s-widget" data-component-type="s-shopping-adviser" cel_widget_id="MAIN-SHOPPING_ADVISER-2">
          <h2><span>People Also Like</span></h2>
          <div class="a-carousel-container">
            <ol class="a-carousel">
              <li class="a-carousel-card">
                <div data-asin="B0RECOPAL2" class="s-result-item">
                  <div data-cy="title-recipe">
                    <a class="a-link-normal" href="/dp/B0RECOPAL2">
                      <h2><span>Dell Inspiron 15 3530 Laptop</span></h2>
                    </a>
                  </div>
                  <div data-cy="price-recipe">
                    <span class="a-price"><span class="a-offscreen">$469.99</span></span>
                  </div>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </div>
    `;

    const parsed = parseAmazonSearchResults(
      createDoc(html),
      'https://www.amazon.com/s?k=laptop',
    );
    const byAsin = new Map(parsed.map((p) => [p.asin, p]));

    // Pure Organic
    const organic = byAsin.get('B0ORGAN001')!;
    expect(resolveListingCategory(organic)).toBe('organic');
    expect(organic.isSponsored).toBe(false);

    // Pure Sponsored Brand
    const spBrand = byAsin.get('B0SPBRND02')!;
    expect(resolveListingCategory(spBrand)).toBe('sponsored');
    expect(spBrand.listingCategory).toBe('sponsored');
    expect(spBrand.sectionLabel).toBe('Sponsored Brand');

    // Recommendation: People Also View
    const recView = byAsin.get('B0RECOPAV1')!;
    expect(resolveListingCategory(recView)).toBe('recommendation');
    expect(recView.listingCategory).toBe('recommendation');
    expect(recView.sectionLabel).toBe('People Also View');
    expect(recView.isSponsored).toBe(false);

    // Recommendation: People Also Like
    const recLike = byAsin.get('B0RECOPAL2')!;
    expect(resolveListingCategory(recLike)).toBe('recommendation');
    expect(recLike.listingCategory).toBe('recommendation');
    expect(recLike.sectionLabel).toBe('People Also Like');

    // Duplicate ASIN (B0DUPL0001): appeared in both Organic Search and Sponsored Brand
    const duplicate = byAsin.get('B0DUPL0001')!;
    expect(resolveListingCategory(duplicate)).toBe('organic');
    expect(resolveProductPlacements(duplicate)).toEqual([
      'Organic Search',
      'Sponsored Brand',
    ]);
    // Matches both 'organic' and 'sponsored' filters due to multi-placement preservation
    expect(matchesListingCategoryFilter(duplicate, 'organic')).toBe(true);
    expect(matchesListingCategoryFilter(duplicate, 'sponsored')).toBe(true);
    expect(matchesListingCategoryFilter(duplicate, 'recommendation')).toBe(false);

    const counts = countProductsByListingCategory(parsed);
    expect(counts).toEqual({
      all: 5,
      organic: 2,
      sponsored: 2,
      recommendation: 2,
    });
  });

  it('renders inline visual badges, filters by Category Pills, and toggles Separate Collapsible Category Sections (disabled by default)', async () => {
    const sampleProducts: Product[] = [
      {
        asin: 'B0ORG00001',
        title: 'Organic ThinkPad Laptop',
        price: 799,
        currency: 'USD',
        rating: 4.8,
        reviewCount: 410,
        brand: 'Lenovo',
        seller: 'Amazon.com',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: 'https://m.media-amazon.com/images/I/org1.jpg',
        url: 'https://www.amazon.com/dp/B0ORG00001',
        description: null,
        features: [],
        source: 'search',
        placements: ['Organic Search', 'Sponsored Brand'],
        collectedAt: '2026-10-18T05:00:00.000Z',
        sessionKey: 'session-cat',
      },
      {
        asin: 'B0SPN00002',
        title: 'Sponsored Brand Gaming Laptop',
        price: 1199,
        currency: 'USD',
        rating: 4.5,
        reviewCount: 95,
        brand: 'ASUS',
        seller: 'ASUS Store',
        availability: 'In Stock',
        isSponsored: true,
        isPrime: true,
        listingCategory: 'sponsored',
        sectionLabel: 'Sponsored Brand',
        imageUrl: 'https://m.media-amazon.com/images/I/spn2.jpg',
        url: 'https://www.amazon.com/dp/B0SPN00002',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-18T05:01:00.000Z',
        sessionKey: 'session-cat',
      },
      {
        asin: 'B0REC00003',
        title: 'Recommended People Also View Laptop',
        price: 549,
        currency: 'USD',
        rating: 4.6,
        reviewCount: 230,
        brand: 'HP',
        seller: 'HP Direct',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        listingCategory: 'recommendation',
        sectionLabel: 'People Also View',
        imageUrl: 'https://m.media-amazon.com/images/I/rec3.jpg',
        url: 'https://www.amazon.com/dp/B0REC00003',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-18T05:02:00.000Z',
        sessionKey: 'session-cat',
      },
    ];

    await db.products.bulkAdd(sampleProducts);

    // 1. Default settings must have separateCategorySections = false
    expect(SettingsSchema.parse({}).separateCategorySections).toBe(false);

    render(
      <>
        <ProductTable />
        <SettingsOverlay />
      </>,
    );

    // Wait for rows and badges to render in unified table mode (default: separate sections OFF)
    await waitFor(() => {
      expect(
        screen.getByTestId('product-category-badge-B0ORG00001').textContent,
      ).toContain('Organic');
      expect(
        screen.getByTestId('product-multi-placement-B0ORG00001').textContent,
      ).toContain('+ Sponsored Brand');
      expect(
        screen.getByTestId('product-category-badge-B0SPN00002').textContent,
      ).toContain('Sponsored');
      expect(
        screen.getByTestId('product-category-badge-B0SPN00002').textContent,
      ).toContain('Sponsored Brand');
      expect(
        screen.getByTestId('product-category-badge-B0REC00003').textContent,
      ).toContain('Recommendation');
      expect(
        screen.getByTestId('product-category-badge-B0REC00003').textContent,
      ).toContain('People Also View');
    });

    // Separate collapsible sections are disabled by default
    expect(screen.queryByTestId('collapsible-category-sections')).toBeNull();

    // 2. Verify Category Filter Pills counts & filtering
    expect(screen.getByTestId('category-pill-all').textContent).toContain('All');
    expect(screen.getByTestId('category-pill-all').textContent).toContain('(3)');
    expect(screen.getByTestId('category-pill-organic').textContent).toContain('(1)');
    expect(screen.getByTestId('category-pill-sponsored').textContent).toContain('(2)');
    expect(screen.getByTestId('category-pill-recommendation').textContent).toContain('(1)');

    // Click "Recommendations" filter pill -> only B0REC00003 should remain
    fireEvent.click(screen.getByTestId('category-pill-recommendation'));
    await waitFor(() => {
      const renderedRows = document.querySelectorAll('tbody tr[data-index]');
      expect(renderedRows).toHaveLength(1);
      expect(renderedRows[0]?.textContent).toContain(
        'Recommended People Also View Laptop',
      );
    });

    // Reset back to "All"
    fireEvent.click(screen.getByTestId('category-pill-all'));
    await waitFor(() => {
      expect(document.querySelectorAll('tbody tr[data-index]')).toHaveLength(3);
    });

    // 3. Enable "Separate collapsible category sections" via SettingsOverlay (or toolbar button)
    useUIStore.setState({ settingsOpen: true });
    const toggleLabel = await screen.findByText(
      'Separate collapsible category sections',
    );
    fireEvent.click(toggleLabel);

    await waitFor(() => {
      expect(
        screen.getByTestId('collapsible-category-sections'),
      ).toBeTruthy();
      expect(screen.getByTestId('category-section-organic')).toBeTruthy();
      expect(
        screen.getByTestId('category-section-sponsored'),
      ).toBeTruthy();
      expect(
        screen.getByTestId('category-section-recommendation'),
      ).toBeTruthy();
    });

    // Collapse the Recommendation section block and verify its table rows collapse
    const recToggle = screen.getByTestId(
      'category-section-toggle-recommendation',
    );
    expect(recToggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(recToggle);
    await waitFor(() => {
      expect(recToggle.getAttribute('aria-expanded')).toBe('false');
    });

    // Disable Separate Sections from the toolbar button and confirm return to unified table
    fireEvent.click(screen.getByTestId('toggle-separate-sections-btn'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('collapsible-category-sections'),
      ).toBeNull();
    });

    // 4. Verify CSV export includes Category/Section placement context
    const csv = buildCSVContent(
      sampleProducts,
      [...DEFAULT_VISIBLE_COLUMNS, 'Category', 'Section'],
      false,
    );
    expect(csv).toContain('Organic Search + Sponsored Brand');
    expect(csv).toContain('Recommendation: People Also View');
  });
});
