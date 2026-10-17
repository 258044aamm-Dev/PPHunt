import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { AmazonFullWidthPreviewModal } from '@/engines/amazon/ui/components/FullWidthPreviewModal';
import { AmazonExtractionCompleteModal } from '@/engines/amazon/ui/components/ExtractionCompleteModal';
import { useAmazonCollectionStore } from '@/engines/amazon/ui/store/collectionStore';
import { useAmazonUIStore } from '@/engines/amazon/ui/store/uiStore';
import { AmazonProductTable } from '@/engines/amazon/ui/table/AmazonProductTable';
import { TemuFullWidthPreviewModal } from '@/engines/temu/ui/components/FullWidthPreviewModal';
import { TemuExtractionCompleteModal } from '@/engines/temu/ui/components/ExtractionCompleteModal';
import { useTemuCollectionStore } from '@/engines/temu/ui/store/collectionStore';
import { useTemuUIStore } from '@/engines/temu/ui/store/uiStore';
import { TemuProductTable } from '@/engines/temu/ui/table/TemuProductTable';
import { temuDb } from '@/engines/temu/db/database';
import { PreviewPageApp } from '@/entrypoints/preview/PreviewPageApp';
import { db } from '@/lib/db/database';
import * as csvModule from '@/lib/export/csv';
import * as clipboardModule from '@/lib/export/clipboard';
import {
  PREVIEW_STATE_STORAGE_KEY,
  buildPreviewTabUrl,
  loadPreviewStateSnapshot,
  openDedicatedPreviewTab,
  parsePreviewTabQueryParams,
  parseSortingFromParam,
  savePreviewStateSnapshot,
  serializeSortingToParam,
  switchFromTabToPanelMode,
} from '@/lib/preview/previewStateSync';
import {
  AMAZON_SORT_PRESETS,
  AMAZON_SORTABLE_FIELDS,
  TEMU_SORT_PRESETS,
  TEMU_SORTABLE_FIELDS,
  getSortPresetsForEngine,
  getSortableFieldsForEngine,
  matchSortPresetId,
  parseSortableBsrRank,
  parseSortableDiscount,
  parseSortableSalesVolume,
  sortProducts,
  toggleMultiColumnSort,
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

const SESSION_AMZ = 'session-multisort-amz';
const SESSION_TEMU = 'session-multisort-temu';

async function seedAmazonProducts() {
  const base = {
    currency: 'USD',
    brand: 'AcousticsCo',
    seller: 'Amazon',
    availability: 'In Stock',
    isSponsored: false,
    isPrime: true,
    imageUrl: null,
    description: null,
    features: [],
    source: 'search' as const,
    pageUrl: 'https://www.amazon.com/s?k=speakers',
    sessionKey: SESSION_AMZ,
  };

  await db.products.bulkAdd([
    {
      ...base,
      asin: 'B0SORT0001',
      title: 'Zeta Studio Monitor',
      price: 150,
      rating: 4.5,
      reviewCount: 300,
      bestSellersRank: '#120 in Musical Instruments',
      pastMonthSales: '500+ bought in past month',
      discountPercentage: '-10%',
      collectedAt: '2026-10-17T10:00:01.000Z',
      url: 'https://www.amazon.com/dp/B0SORT0001',
    },
    {
      ...base,
      asin: 'B0SORT0002',
      title: 'Alpha Portable Speaker',
      price: 50,
      rating: 4.8,
      reviewCount: 2500,
      bestSellersRank: '#5 in Portable Bluetooth Speakers',
      pastMonthSales: '10K+ bought in past month',
      discountPercentage: '-35%',
      collectedAt: '2026-10-17T10:00:02.000Z',
      url: 'https://www.amazon.com/dp/B0SORT0002',
    },
    {
      ...base,
      asin: 'B0SORT0003',
      title: 'Beta Bookshelf Speaker',
      price: 50,
      rating: 4.9,
      reviewCount: 900,
      bestSellersRank: '#18 in Home Audio Speakers',
      pastMonthSales: '2.5K+ bought in past month',
      discountPercentage: '-20%',
      collectedAt: '2026-10-17T10:00:03.000Z',
      url: 'https://www.amazon.com/dp/B0SORT0003',
    },
  ]);
}

async function seedTemuProducts() {
  const base = {
    currency: 'USD',
    brand: 'TemuAudio',
    seller: 'Temu Direct',
    availability: 'In Stock',
    isSponsored: false,
    isPrime: true,
    imageUrl: null,
    description: null,
    features: [],
    source: 'search' as const,
    sessionId: SESSION_TEMU,
  };

  await temuDb.products.bulkAdd([
    {
      ...base,
      goodsId: '601099000001',
      asin: '601099000001',
      title: 'Omega Wireless Earbuds',
      price: 25.99,
      rating: 4.4,
      reviewCount: 150,
      bestSellersRank: '#40 in Electronics',
      pastMonthSales: '1.2K+ sold',
      discountPercentage: '-15%',
      collectedAt: '2026-10-17T11:00:01.000Z',
      url: 'https://www.temu.com/goods.html?goods_id=601099000001',
    },
    {
      ...base,
      goodsId: '601099000002',
      asin: '601099000002',
      title: 'Delta Mini Soundbar',
      price: 12.49,
      rating: 4.9,
      reviewCount: 4200,
      bestSellersRank: '#2 in Soundbars',
      pastMonthSales: '50K+ sold',
      discountPercentage: '-60%',
      collectedAt: '2026-10-17T11:00:02.000Z',
      url: 'https://www.temu.com/goods.html?goods_id=601099000002',
    },
  ]);
}

describe('Dedicated Preview Tab, 3-Mode Switching & Sort-Preserving Export (SAD-245..SAD-258)', () => {
  const createTabSpy = vi.fn().mockResolvedValue({ id: 901 });
  const updateTabSpy = vi.fn().mockResolvedValue({ id: 901 });

  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();

    await temuDb.open();
    await temuDb.products.clear();
    await temuDb.history.clear();
    await temuDb.settings.clear();

    localStorage.removeItem(PREVIEW_STATE_STORAGE_KEY);
    createTabSpy.mockClear();
    updateTabSpy.mockClear();

    useAmazonCollectionStore.getState().reset();
    useAmazonUIStore.setState({
      activeTab: 'collect',
      settingsOpen: false,
      completionDialogOpen: false,
      previewOverlayOpen: false,
      previewMode: 'overview',
      previewSorting: [],
      previewGlobalFilter: '',
      exportModalOpen: false,
      selectedSessionKey: null,
    });

    useTemuCollectionStore.getState().reset();
    useTemuUIStore.setState({
      activeTab: 'collect',
      settingsOpen: false,
      completionDialogOpen: false,
      previewOverlayOpen: false,
      previewMode: 'overview',
      previewSorting: [],
      previewGlobalFilter: '',
      exportModalOpen: false,
      selectedSessionId: null,
    });

    vi.stubGlobal('browser', {
      runtime: {
        getURL: (path: string) => `chrome-extension://test-ext-id${path}`,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 101, url: 'https://www.amazon.com/s?k=speakers' },
        ]),
        create: createTabSpy,
        update: updateTabSpy,
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses domain-specific BSR, sales volume, and discount strings and executes multi-column sorting with null values last', () => {
    expect(parseSortableBsrRank('#1,234 in Kitchen & Dining')).toBe(1234);
    expect(parseSortableBsrRank('#5 in Portable Speakers')).toBe(5);
    expect(parseSortableBsrRank(null)).toBeNull();

    expect(parseSortableSalesVolume('10K+ bought in past month')).toBe(10_000);
    expect(parseSortableSalesVolume('2.5M+ sold')).toBe(2_500_000);
    expect(parseSortableSalesVolume('500+ bought')).toBe(500);
    expect(parseSortableSalesVolume(undefined)).toBeNull();

    expect(parseSortableDiscount('-35%')).toBe(35);
    expect(parseSortableDiscount('Save 20%')).toBe(20);
    expect(parseSortableDiscount('')).toBeNull();

    expect(AMAZON_SORT_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(TEMU_SORT_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(AMAZON_SORTABLE_FIELDS.length).toBeGreaterThan(5);
    expect(TEMU_SORTABLE_FIELDS.length).toBeGreaterThan(5);
    expect(getSortPresetsForEngine('amazon')).toBe(AMAZON_SORT_PRESETS);
    expect(getSortPresetsForEngine('temu')).toBe(TEMU_SORT_PRESETS);
    expect(getSortableFieldsForEngine('amazon')).toBe(AMAZON_SORTABLE_FIELDS);
    expect(getSortableFieldsForEngine('temu')).toBe(TEMU_SORTABLE_FIELDS);

    const rows = [
      { id: 1, price: 50, rating: 4.5, title: 'C' },
      { id: 2, price: null, rating: 5.0, title: 'D' },
      { id: 3, price: 50, rating: 4.9, title: 'A' },
      { id: 4, price: 20, rating: 4.1, title: 'B' },
    ];

    // Multi-sort: Price Low->High, then Rating High->Low (null price always last)
    const sorted = sortProducts(rows, [
      { id: 'price', desc: false },
      { id: 'rating', desc: true },
    ]);
    expect(sorted.map((r) => r.id)).toEqual([4, 3, 1, 2]);

    // Toggle multi-column sort helper
    const s1 = toggleMultiColumnSort([], 'price', false, false);
    expect(s1).toEqual([{ id: 'price', desc: false }]);
    expect(matchSortPresetId(s1, 'amazon')).toBe('price_asc');

    const s2 = toggleMultiColumnSort(s1, 'rating', true, true);
    expect(s2).toEqual([
      { id: 'price', desc: false },
      { id: 'rating', desc: true },
    ]);
    expect(matchSortPresetId(s2, 'amazon')).toBe('custom');
  });

  it('serializes and synchronizes preview state across Sidebar, Overview, and Dedicated Browser Tab URLs', async () => {
    const sorting = [
      { id: 'price', desc: false },
      { id: 'rating', desc: true },
    ];
    const encoded = serializeSortingToParam(sorting);
    expect(encoded).toBe('price:asc,rating:desc');
    expect(parseSortingFromParam(encoded)).toEqual(sorting);

    const url = buildPreviewTabUrl({
      engine: 'amazon',
      sessionKey: SESSION_AMZ,
      sorting,
      globalFilter: 'speaker',
    });
    expect(url).toContain('/preview.html?');
    const query = url.slice(url.indexOf('?'));
    const parsed = parsePreviewTabQueryParams(query);
    expect(parsed).toEqual({
      engine: 'amazon',
      sessionKey: SESSION_AMZ,
      sorting,
      globalFilter: 'speaker',
    });

    await savePreviewStateSnapshot({
      engine: 'temu',
      sessionKey: SESSION_TEMU,
      sorting,
      globalFilter: 'earbuds',
      mode: 'overview',
    });
    const loaded = await loadPreviewStateSnapshot();
    expect(loaded?.engine).toBe('temu');
    expect(loaded?.sessionKey).toBe(SESSION_TEMU);
    expect(loaded?.sorting).toEqual(sorting);

    await openDedicatedPreviewTab({
      engine: 'amazon',
      sessionKey: SESSION_AMZ,
      sorting,
      globalFilter: 'speaker',
    });
    expect(createTabSpy).toHaveBeenCalledTimes(1);
    expect(createTabSpy.mock.calls[0]?.[0]?.url).toContain(
      'sessionKey=session-multisort-amz',
    );

    const switchedBack = await switchFromTabToPanelMode('sidebar', {
      engine: 'amazon',
      sessionKey: SESSION_AMZ,
      sorting,
      globalFilter: 'speaker',
    });
    expect(switchedBack.mode).toBe('sidebar');
    expect(updateTabSpy).toHaveBeenCalledWith(101, { active: true });
  });

  it('supports preset sorting, secondary multi-column sorting, and preserves active sort order on CSV and Clipboard export across scopes', async () => {
    await seedAmazonProducts();
    const csvSpy = vi.spyOn(csvModule, 'exportCSV').mockImplementation(() => {});
    const clipboardSpy = vi
      .spyOn(clipboardModule, 'exportClipboard')
      .mockResolvedValue(undefined);

    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    // Wait for all 3 products to render in default collectedAt descending order
    await waitFor(() => {
      const bodyRows = Array.from(
        document.querySelectorAll('tbody tr[data-index]'),
      );
      expect(bodyRows).toHaveLength(3);
      expect(bodyRows[0]?.textContent).toContain('Beta Bookshelf Speaker');
    });

    // 1. Select preset "Best Sellers Rank: Best First"
    const presetSelect = screen.getByTestId('table-sort-preset-select');
    fireEvent.change(presetSelect, { target: { value: 'bsr_asc' } });

    await waitFor(() => {
      const bodyRows = Array.from(
        document.querySelectorAll('tbody tr[data-index]'),
      );
      // #5 Alpha, #18 Beta, #120 Zeta
      expect(bodyRows[0]?.textContent).toContain('Alpha Portable Speaker');
      expect(bodyRows[1]?.textContent).toContain('Beta Bookshelf Speaker');
      expect(bodyRows[2]?.textContent).toContain('Zeta Studio Monitor');
    });

    // 2. Select preset "Price: Low to High", then add secondary sort "Rating (High->Low)"
    fireEvent.change(presetSelect, { target: { value: 'price_asc' } });
    const addSortSelect = screen.getByTestId('table-add-sort-select');
    fireEvent.change(addSortSelect, { target: { value: 'rating' } });

    await waitFor(() => {
      // Active sort pills show both rules: 1. Price ↑ Asc and 2. Rating ↓ Desc
      expect(screen.getByTestId('sort-pill-price')).toBeTruthy();
      expect(screen.getByTestId('sort-pill-rating')).toBeTruthy();

      const bodyRows = Array.from(
        document.querySelectorAll('tbody tr[data-index]'),
      );
      // Both Alpha and Beta are $50, but Beta has 4.9 rating vs Alpha's 4.8!
      expect(bodyRows[0]?.textContent).toContain('Beta Bookshelf Speaker');
      expect(bodyRows[1]?.textContent).toContain('Alpha Portable Speaker');
      expect(bodyRows[2]?.textContent).toContain('Zeta Studio Monitor');
    });

    // 3. Export via TableToolbar -> verify exported products preserve the exact multi-sort order!
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const exportBtn = await screen.findByRole('button', {
      name: 'Export 3 products',
    });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(csvSpy).toHaveBeenCalledTimes(1);
    });
    const exportedProducts = csvSpy.mock.calls[0]?.[0] ?? [];
    expect(exportedProducts.map((p) => p.asin)).toEqual([
      'B0SORT0003', // Beta ($50, 4.9★)
      'B0SORT0002', // Alpha ($50, 4.8★)
      'B0SORT0001', // Zeta ($150, 4.5★)
    ]);

    // 4. Also verify Clipboard export preserves sort order (ExportModal remains open)
    const clipboardBtn = await screen.findByRole('button', {
      name: 'Copy',
    });
    fireEvent.click(clipboardBtn);
    const copyBtn = await screen.findByRole('button', {
      name: 'Copy 3 products',
    });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(clipboardSpy).toHaveBeenCalledTimes(1);
    });
    const clipboardProducts = clipboardSpy.mock.calls[0]?.[0] ?? [];
    expect(clipboardProducts.map((p) => p.asin)).toEqual([
      'B0SORT0003',
      'B0SORT0002',
      'B0SORT0001',
    ]);
  });

  it('switches seamlessly between Sidebar, Overview 95vw, and Dedicated Browser Tab in both Amazon and Temu previews while preserving sort order on header export', async () => {
    await seedAmazonProducts();
    await seedTemuProducts();
    const csvSpy = vi.spyOn(csvModule, 'exportCSV').mockImplementation(() => {});

    useAmazonUIStore.getState().openPreviewOverlay(SESSION_AMZ, 'overview');

    render(
      <>
        <AmazonFullWidthPreviewModal />
        <AmazonExtractionCompleteModal />
      </>,
    );

    const overlay = await screen.findByTestId('fullwidth-preview-overlay');
    expect(overlay.getAttribute('data-preview-mode')).toBe('overview');

    // Sort by Monthly Sales: High to Low in Overview mode
    const presetSelect = await within(overlay).findByTestId(
      'table-sort-preset-select',
    );
    fireEvent.change(presetSelect, { target: { value: 'sales_desc' } });

    await waitFor(() => {
      const bodyRows = Array.from(
        overlay.querySelectorAll('tbody tr[data-index]'),
      );
      // 10K+ Alpha, 2.5K+ Beta, 500+ Zeta
      expect(bodyRows[0]?.textContent).toContain('Alpha Portable Speaker');
      expect(bodyRows[1]?.textContent).toContain('Beta Bookshelf Speaker');
      expect(bodyRows[2]?.textContent).toContain('Zeta Studio Monitor');
    });

    // Switch to Sidebar mode -> layout attribute updates to 'sidebar' and sort order stays intact!
    fireEvent.click(within(overlay).getByTestId('preview-mode-sidebar'));
    expect(overlay.getAttribute('data-preview-mode')).toBe('sidebar');
    expect(useAmazonUIStore.getState().previewSorting).toEqual([
      { id: 'pastMonthSales', desc: true },
    ]);

    // Click header "Export Current Extraction" -> preserves Monthly Sales sort order!
    fireEvent.click(
      within(overlay).getByRole('button', {
        name: 'Export Current Extraction',
      }),
    );
    const modalExportBtn = await screen.findByRole('button', {
      name: 'Export 3 products',
    });
    fireEvent.click(modalExportBtn);

    await waitFor(() => {
      expect(csvSpy).toHaveBeenCalledTimes(1);
    });
    expect(csvSpy.mock.calls[0]?.[0]?.map((p) => p.asin)).toEqual([
      'B0SORT0002', // 10K+
      'B0SORT0003', // 2.5K+
      'B0SORT0001', // 500+
    ]);

    // Switch to Dedicated Tab mode -> opens /preview.html with sort=pastMonthSales:desc
    fireEvent.click(within(overlay).getByTestId('preview-mode-tab'));
    await waitFor(() => {
      expect(createTabSpy).toHaveBeenCalledTimes(1);
    });
    expect(createTabSpy.mock.calls[0]?.[0]?.url).toContain(
      'sort=pastMonthSales%3Adesc',
    );

    cleanup();

    // Verify Temu FullWidthPreviewModal and Dedicated PreviewPageApp
    useTemuUIStore.getState().openPreviewOverlay(SESSION_TEMU, 'overview');
    render(
      <>
        <TemuFullWidthPreviewModal />
        <TemuExtractionCompleteModal />
      </>,
    );

    const temuOverlay = await screen.findByTestId(
      'temu-fullwidth-preview-overlay',
    );
    const temuPresetSelect = await within(temuOverlay).findByTestId(
      'table-sort-preset-select',
    );
    fireEvent.change(temuPresetSelect, { target: { value: 'discount_desc' } });

    await waitFor(() => {
      const bodyRows = Array.from(
        temuOverlay.querySelectorAll('tbody tr[data-index]'),
      );
      // -60% Delta first, -15% Omega second
      expect(bodyRows[0]?.textContent).toContain('Delta Mini Soundbar');
      expect(bodyRows[1]?.textContent).toContain('Omega Wireless Earbuds');
    });

    cleanup();

    // Render standalone Dedicated Preview Tab (/preview.html)
    render(<PreviewPageApp />);
    const dedicatedPage = await screen.findByTestId('dedicated-preview-page');
    expect(dedicatedPage).toBeTruthy();

    // Switch engine to Temu in Dedicated Preview Tab
    fireEvent.click(screen.getByTestId('preview-page-engine-temu'));
    await waitFor(() => {
      expect(
        screen
          .getByTestId('preview-page-engine-temu')
          .getAttribute('aria-pressed'),
      ).toBe('true');
    });

    // Also render standalone TemuProductTable to verify direct table sorting
    cleanup();
    render(<TemuProductTable fullHeight sessionId={SESSION_TEMU} />);
    await waitFor(() => {
      expect(screen.getByTestId('table-sort-preset-select')).toBeTruthy();
    });
  });
});
