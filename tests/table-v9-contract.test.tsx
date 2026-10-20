import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import {
  sortFn_alphanumeric,
  sortFn_basic,
} from '@tanstack/react-table';
import { db } from '@/lib/db/database';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import {
  getColumnsForSettings,
} from '@/entrypoints/sidepanel/table/columns';
import { DEFAULT_ENABLED_FIELDS } from '@/lib/schemas/settings';

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

/**
 * Step 7.1 (SAD-186) contract tests — pin the v9 migration to the runtime
 * contract recorded in Step 7.0 (PR #1 description): same column ids, same
 * order, same sizing, same sort-fn mapping, and a working row-selection
 * round-trip through the v9 feature APIs.
 *
 * SAD-333 deliberately changes one thing: `description` and `features` became
 * default-on, so they are now inserted between `url` and `source`. Every other
 * id, its relative order, its sizing and its sort-fn stay pinned to the
 * recorded order below — the change is exactly those two insertions.
 */

/**
 * Structural view of a column def for assertions. Column defs are unions, so
 * the test reads the handful of documented properties through this shape
 * (cast goes through `unknown`, never `any`).
 */
type ColShape = {
  id?: string;
  accessorKey?: string;
  size?: number;
  minSize?: number;
  maxSize?: number;
  sortFn?: unknown;
};

const asShapes = (cols: unknown): ColShape[] => cols as ColShape[];

/** The exact default column order recorded at f773d87 (Step 7.0), pre-SAD-333. */
const LEGACY_COLUMN_IDS = [
  'select',
  'rowNumber',
  'imageUrl',
  'title',
  'asin',
  'price',
  'listPrice',
  'discountPercentage',
  'dealBadge',
  'currency',
  'rating',
  'reviewCount',
  'bestSellersRank',
  'pastMonthSales',
  'coupon',
  'badge',
  'delivery',
  'brand',
  'seller',
  'availability',
  'isPrime',
  'isSponsored',
  'url',
  'source',
];

/** SAD-333 + SAD-349: the PDP-only columns are default-on, before `source`. */
const DEFAULT_COLUMN_IDS = [
  ...LEGACY_COLUMN_IDS.slice(0, LEGACY_COLUMN_IDS.length - 1),
  'description',
  'features',
  'warrantyDescription',
  'source',
];

/** size / minSize / maxSize per column, recorded at f773d87 (Step 7.0). */
const COLUMN_SIZING: Record<string, [number, number, number]> = {
  select: [40, 40, 40],
  rowNumber: [44, 36, 64],
  imageUrl: [56, 48, 72],
  title: [280, 160, 500],
  asin: [96, 80, 120],
  price: [90, 70, 120],
  listPrice: [96, 76, 130],
  discountPercentage: [88, 72, 120],
  dealBadge: [136, 100, 200],
  currency: [64, 52, 84],
  rating: [100, 80, 130],
  reviewCount: [76, 56, 110],
  bestSellersRank: [160, 120, 280],
  pastMonthSales: [150, 110, 220],
  coupon: [140, 100, 220],
  badge: [124, 90, 180],
  delivery: [150, 110, 240],
  brand: [110, 80, 200],
  seller: [110, 80, 200],
  availability: [120, 90, 220],
  isPrime: [68, 56, 90],
  isSponsored: [84, 68, 110],
  url: [110, 80, 200],
  source: [76, 64, 96],
  description: [200, 120, 400],
  features: [200, 120, 400],
  warrantyDescription: [110, 90, 160],
};

/** Columns whose sortFn must be sortFn_basic (all others: sortFn_alphanumeric). */
const BASIC_SORT_IDS = [
  'price',
  'listPrice',
  'rating',
  'reviewCount',
  'isPrime',
  'isSponsored',
];

function colId(col: ColShape): string {
  if (typeof col.id === 'string') return col.id;
  if (typeof col.accessorKey === 'string') return col.accessorKey;
  throw new Error('column without id or accessorKey');
}

describe('Table v9 migration contract (SAD-186 / Step 7.1)', () => {
  it('getColumnsForSettings(DEFAULT_ENABLED_FIELDS) returns the recorded ids in the recorded order', () => {
    const cols = asShapes(getColumnsForSettings(DEFAULT_ENABLED_FIELDS));
    expect(cols.map(colId)).toEqual(DEFAULT_COLUMN_IDS);
  });

  it('getColumnsForSettings(undefined) returns the same columns as the defaults', () => {
    const cols = asShapes(getColumnsForSettings(undefined));
    expect(cols.map(colId)).toEqual(DEFAULT_COLUMN_IDS);
  });

  it('every column keeps its recorded size/minSize/maxSize', () => {
    const cols = asShapes(
      getColumnsForSettings({
        ...DEFAULT_ENABLED_FIELDS,
        description: true,
        features: true,
      })
    );
    expect(cols.map(colId)).toEqual(DEFAULT_COLUMN_IDS);
    for (const col of cols) {
      const id = colId(col);
      const expected = COLUMN_SIZING[id];
      expect(expected, `no recorded sizing for ${id}`).toBeDefined();
      expect([col.size, col.minSize, col.maxSize]).toEqual(expected);
    }
  });

  it('keeps the recorded sort-fn mapping (basic vs alphanumeric)', () => {
    const cols = asShapes(getColumnsForSettings(DEFAULT_ENABLED_FIELDS));
    for (const col of cols) {
      const id = colId(col);
      if (BASIC_SORT_IDS.includes(id)) {
        expect(col.sortFn, `${id} sortFn`).toBe(sortFn_basic);
      } else if ('sortFn' in col) {
        expect(col.sortFn, `${id} sortFn`).toBe(sortFn_alphanumeric);
      }
    }
  });

  it('toggling each enabledFields key off removes exactly that column', () => {
    for (const key of Object.keys(DEFAULT_ENABLED_FIELDS) as Array<
      keyof typeof DEFAULT_ENABLED_FIELDS
    >) {
      const cols = asShapes(
        getColumnsForSettings({
          ...DEFAULT_ENABLED_FIELDS,
          [key]: false,
        })
      );
      const ids = cols.map(colId);
      expect(ids, `toggling ${key} off`).toEqual(
        DEFAULT_COLUMN_IDS.filter((id) => id !== key)
      );
    }
  });

  it('renders the PDP-only columns by default and drops exactly them when turned off (SAD-333 + SAD-349)', () => {
    const defaults = asShapes(getColumnsForSettings(DEFAULT_ENABLED_FIELDS))
      .map(colId);
    expect(defaults).toContain('description');
    expect(defaults).toContain('features');
    expect(defaults).toContain('warrantyDescription');

    // Turning off every PDP-only field returns exactly the frozen pre-SAD-333
    // set, which is what this test has always pinned.
    const turnedOff = asShapes(
      getColumnsForSettings({
        ...DEFAULT_ENABLED_FIELDS,
        description: false,
        features: false,
        warrantyDescription: false,
      })
    ).map(colId);
    expect(turnedOff).toEqual(LEGACY_COLUMN_IDS);
    expect(turnedOff).not.toContain('description');
    expect(turnedOff).not.toContain('features');
    expect(turnedOff).not.toContain('warrantyDescription');
  });
});

describe('Row-selection round-trip through the v9 feature APIs (SAD-186)', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('select-all marks every row (Record<string, true> shape), deselect clears it', async () => {
    await db.products.bulkAdd([
      {
        asin: 'B09V3KXJP1',
        title: 'First Product',
        price: 10,
        currency: 'USD',
        rating: 4,
        reviewCount: 10,
        brand: 'BrandA',
        seller: 'Amazon',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: null,
        url: 'https://www.amazon.com/dp/B09V3KXJP1',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:00:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=test',
        sessionKey: 'contract-test',
      },
      {
        asin: 'B09V3KXJP2',
        title: 'Second Product',
        price: 20,
        currency: 'USD',
        rating: 3,
        reviewCount: 20,
        brand: 'BrandB',
        seller: 'SellerB',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: false,
        imageUrl: null,
        url: 'https://www.amazon.com/dp/B09V3KXJP2',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:01:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=test',
        sessionKey: 'contract-test',
      },
    ]);

    render(<ProductTable />);

    // Wait for the live query to deliver both rows
    await waitFor(() => {
      expect(screen.getByLabelText('Select product B09V3KXJP1')).toBeTruthy();
      expect(screen.getByLabelText('Select product B09V3KXJP2')).toBeTruthy();
    });

    const rowA = screen.getByLabelText('Select product B09V3KXJP1') as HTMLInputElement;
    const rowB = screen.getByLabelText('Select product B09V3KXJP2') as HTMLInputElement;
    const headerCheckbox = screen.getByLabelText('Select all rows') as HTMLInputElement;

    // Initially nothing is selected
    expect(rowA.checked).toBe(false);
    expect(rowB.checked).toBe(false);
    expect(headerCheckbox.checked).toBe(false);

    // Toolbar select-all builds the full Record<string, true> over filteredProducts
    fireEvent.click(screen.getByText('Select all'));
    await waitFor(() => {
      expect(rowA.checked).toBe(true);
      expect(rowB.checked).toBe(true);
      // getIsAllPageRowsSelected() must agree — v9 keys rows via getRowId
      expect(headerCheckbox.checked).toBe(true);
    });

    // Deselect resets to {} — every box clears, including the header
    fireEvent.click(screen.getByText('Deselect'));
    await waitFor(() => {
      expect(rowA.checked).toBe(false);
      expect(rowB.checked).toBe(false);
      expect(headerCheckbox.checked).toBe(false);
    });
  });

  it('per-row toggle selects exactly one row and leaves the header unchecked', async () => {
    await db.products.bulkAdd([
      {
        asin: 'B09V3KXJP3',
        title: 'Third Product',
        price: 30,
        currency: 'USD',
        rating: 5,
        reviewCount: 30,
        brand: 'BrandC',
        seller: 'Amazon',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: null,
        url: 'https://www.amazon.com/dp/B09V3KXJP3',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:02:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=test',
        sessionKey: 'contract-test',
      },
      {
        asin: 'B09V3KXJP4',
        title: 'Fourth Product',
        price: 40,
        currency: 'USD',
        rating: 2,
        reviewCount: 40,
        brand: 'BrandD',
        seller: 'SellerD',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: false,
        imageUrl: null,
        url: 'https://www.amazon.com/dp/B09V3KXJP4',
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-16T12:03:00.000Z',
        pageUrl: 'https://www.amazon.com/s?k=test',
        sessionKey: 'contract-test',
      },
    ]);

    render(<ProductTable />);
    await waitFor(() => {
      expect(screen.getByLabelText('Select product B09V3KXJP3')).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText('Select product B09V3KXJP3'));
    await waitFor(() => {
      expect(
        (screen.getByLabelText('Select product B09V3KXJP3') as HTMLInputElement).checked
      ).toBe(true);
      expect(
        (screen.getByLabelText('Select product B09V3KXJP4') as HTMLInputElement).checked
      ).toBe(false);
      expect(
        (screen.getByLabelText('Select all rows') as HTMLInputElement).checked
      ).toBe(false);
    });
  });
});

describe('Row-height invariant behind the constant ROW_HEIGHT = 52 (SAD-187 / Step 7.2)', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('clamps every text cell to at most two lines so the 52px estimate cannot drift', async () => {
    const longTitle =
      'Anker Prime Power Bank 27650mAh 250W Fast Charging 3-Port Portable Charger ' +
      'with Smart Digital Display for iPhone 15/15 Pro Max Samsung Galaxy S24 MacBook ' +
      'Pro iPad Pro Steam Deck ASUS ROG Ally Dell XPS Lenovo ThinkPad keyword stuffed'.repeat(2);
    await db.products.add({
      asin: 'B09V3KXLNG',
      title: longTitle,
      price: 129.99,
      currency: 'USD',
      rating: 4.7,
      reviewCount: 8123,
      brand: 'Anker',
      seller: 'Amazon.com',
      availability: 'Only 3 left in stock - order soon. Ships from and sold by Amazon.com',
      isSponsored: true,
      isPrime: true,
      imageUrl: null,
      url: 'https://www.amazon.com/dp/B09V3KXLNG',
      description: null,
      features: [],
      source: 'search',
      collectedAt: '2026-10-16T12:00:00.000Z',
      pageUrl: 'https://www.amazon.com/s?k=test',
        sessionKey: 'contract-test',
    });

    render(<ProductTable />);
    const link = await screen.findByText(longTitle);

    // Title is the tallest cell: line-clamp-2 (Tailwind 3.3+ core) + py-1.5 on the td
    // keeps the worst case (~45px) under the constant ROW_HEIGHT = 52.
    expect(link.className).toContain('line-clamp-2');

    // Every other text cell must stay single-line: clamp-1 or nowrap.
    const availability = screen.getByText(
      'Only 3 left in stock - order soon. Ships from and sold by Amazon.com'
    );
    expect(availability.className).toContain('line-clamp-1');
    const seller = screen.getByText('Amazon.com');
    expect(seller.className).toContain('line-clamp-1');
    const brand = screen.getByText('Anker');
    expect(brand.className).toContain('line-clamp-1');
  });
});

describe('SAD-333: Description and Features are on for a default install', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders both column headers with no settings row and no opt-in', async () => {
    await db.products.put({
      asin: 'B09V3KXJP3',
      title: 'Enriched Product',
      price: 30,
      currency: 'USD',
      rating: 4.5,
      reviewCount: 30,
      brand: 'BrandC',
      seller: 'Amazon',
      availability: 'In Stock',
      isSponsored: false,
      isPrime: true,
      imageUrl: null,
      url: 'https://www.amazon.com/dp/B09V3KXJP3',
      description: 'A description that only the product page could provide.',
      features: ['Feature one', 'Feature two'],
      source: 'detail',
      collectedAt: '2026-10-16T12:02:00.000Z',
      pageUrl: 'https://www.amazon.com/dp/B09V3KXJP3',
      sessionKey: 'sad-333-defaults',
    });

    render(<ProductTable />);

    await waitFor(() => {
      expect(screen.getByLabelText('Select product B09V3KXJP3')).toBeTruthy();
    });

    // The settings row is seeded from the new defaults on first read.
    expect(screen.getByText('Description')).toBeTruthy();
    expect(screen.getByText('Features')).toBeTruthy();
    expect(
      screen.getByText('A description that only the product page could provide.')
    ).toBeTruthy();
    expect(screen.getByText('Feature one • Feature two')).toBeTruthy();
  });
});
