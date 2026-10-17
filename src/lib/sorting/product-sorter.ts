import type { SortingState } from '@tanstack/react-table';

export interface SortPresetOption {
  id: string;
  label: string;
  sorting: SortingState;
}

export interface SortableFieldOption {
  id: string;
  label: string;
  defaultDesc: boolean;
}

export const AMAZON_SORTABLE_FIELDS: readonly SortableFieldOption[] = [
  { id: 'price', label: 'Price', defaultDesc: false },
  { id: 'rating', label: 'Rating', defaultDesc: true },
  { id: 'reviewCount', label: 'Reviews', defaultDesc: true },
  { id: 'bestSellersRank', label: 'BSR', defaultDesc: false },
  { id: 'pastMonthSales', label: 'Monthly Sales', defaultDesc: true },
  { id: 'discountPercentage', label: 'Discount', defaultDesc: true },
  { id: 'listPrice', label: 'List Price', defaultDesc: true },
  { id: 'title', label: 'Title', defaultDesc: false },
  { id: 'brand', label: 'Brand', defaultDesc: false },
  { id: 'seller', label: 'Seller', defaultDesc: false },
  { id: 'asin', label: 'ASIN', defaultDesc: false },
  { id: 'isPrime', label: 'Prime', defaultDesc: true },
  { id: 'isSponsored', label: 'Sponsored', defaultDesc: true },
];

export const TEMU_SORTABLE_FIELDS: readonly SortableFieldOption[] = [
  { id: 'price', label: 'Price', defaultDesc: false },
  { id: 'rating', label: 'Rating', defaultDesc: true },
  { id: 'reviewCount', label: 'Reviews', defaultDesc: true },
  { id: 'soldCount', label: 'Sold Volume', defaultDesc: true },
  { id: 'discountPercentage', label: 'Discount', defaultDesc: true },
  { id: 'originalPrice', label: 'List Price', defaultDesc: true },
  { id: 'title', label: 'Title', defaultDesc: false },
  { id: 'mallName', label: 'Seller / Mall', defaultDesc: false },
  { id: 'goodsId', label: 'Goods ID', defaultDesc: false },
  { id: 'isSponsored', label: 'Sponsored', defaultDesc: true },
];

export const AMAZON_SORT_PRESETS: readonly SortPresetOption[] = [
  { id: 'default', label: 'Collected: Newest First', sorting: [] },
  {
    id: 'price_asc',
    label: 'Price: Low to High',
    sorting: [{ id: 'price', desc: false }],
  },
  {
    id: 'price_desc',
    label: 'Price: High to Low',
    sorting: [{ id: 'price', desc: true }],
  },
  {
    id: 'rating_desc',
    label: 'Rating: High to Low',
    sorting: [
      { id: 'rating', desc: true },
      { id: 'reviewCount', desc: true },
    ],
  },
  {
    id: 'reviews_desc',
    label: 'Reviews: High to Low',
    sorting: [{ id: 'reviewCount', desc: true }],
  },
  {
    id: 'bsr_asc',
    label: 'Best Sellers Rank: Best First',
    sorting: [{ id: 'bestSellersRank', desc: false }],
  },
  {
    id: 'sales_desc',
    label: 'Monthly Sales: High to Low',
    sorting: [{ id: 'pastMonthSales', desc: true }],
  },
  {
    id: 'discount_desc',
    label: 'Discount: High to Low',
    sorting: [{ id: 'discountPercentage', desc: true }],
  },
  {
    id: 'title_asc',
    label: 'Title: A–Z',
    sorting: [{ id: 'title', desc: false }],
  },
  {
    id: 'title_desc',
    label: 'Title: Z–A',
    sorting: [{ id: 'title', desc: true }],
  },
];

export const TEMU_SORT_PRESETS: readonly SortPresetOption[] = [
  { id: 'default', label: 'Collected: Newest First', sorting: [] },
  {
    id: 'price_asc',
    label: 'Price: Low to High',
    sorting: [{ id: 'price', desc: false }],
  },
  {
    id: 'price_desc',
    label: 'Price: High to Low',
    sorting: [{ id: 'price', desc: true }],
  },
  {
    id: 'rating_desc',
    label: 'Rating: High to Low',
    sorting: [
      { id: 'rating', desc: true },
      { id: 'reviewCount', desc: true },
    ],
  },
  {
    id: 'reviews_desc',
    label: 'Reviews: High to Low',
    sorting: [{ id: 'reviewCount', desc: true }],
  },
  {
    id: 'sales_desc',
    label: 'Sold Volume: High to Low',
    sorting: [{ id: 'soldCount', desc: true }],
  },
  {
    id: 'discount_desc',
    label: 'Discount: High to Low',
    sorting: [{ id: 'discountPercentage', desc: true }],
  },
  {
    id: 'title_asc',
    label: 'Title: A–Z',
    sorting: [{ id: 'title', desc: false }],
  },
  {
    id: 'title_desc',
    label: 'Title: Z–A',
    sorting: [{ id: 'title', desc: true }],
  },
];

export function getSortPresetsForEngine(
  engine: 'amazon' | 'temu',
): readonly SortPresetOption[] {
  return engine === 'temu' ? TEMU_SORT_PRESETS : AMAZON_SORT_PRESETS;
}

export function getSortableFieldsForEngine(
  engine: 'amazon' | 'temu',
): readonly SortableFieldOption[] {
  return engine === 'temu' ? TEMU_SORTABLE_FIELDS : AMAZON_SORTABLE_FIELDS;
}

export function matchSortPresetId(
  sorting: SortingState,
  engine: 'amazon' | 'temu' = 'amazon',
): string {
  if (!sorting || sorting.length === 0) return 'default';
  const presets = getSortPresetsForEngine(engine);
  for (const preset of presets) {
    if (preset.sorting.length !== sorting.length) continue;
    const matches = preset.sorting.every(
      (rule, idx) =>
        sorting[idx]?.id === rule.id && sorting[idx]?.desc === rule.desc,
    );
    if (matches) return preset.id;
  }
  return 'custom';
}

/**
 * Parses an Amazon Best Sellers Rank string (`#12 in Electronics`, `#1,245`) into an integer rank.
 */
export function parseSortableBsrRank(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /#?\s*(\d[\d,]*)/.exec(value);
  if (!match?.[1]) return null;
  const num = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parses a sales volume string (`10K+ bought in past month`, `5.2K+ sold`, `1.5M+ sold`, `500+`)
 * into a comparable numeric volume.
 */
export function parseSortableSalesVolume(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /(\d[\d,]*(?:\.\d+)?)\s*([KkMmBb])?/.exec(value);
  if (!match?.[1]) return null;
  const base = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'K') return Math.round(base * 1_000);
  if (suffix === 'M') return Math.round(base * 1_000_000);
  if (suffix === 'B') return Math.round(base * 1_000_000_000);
  return base;
}

/**
 * Parses a discount string (`-25%`, `25% off`, `Save 15%`) into a positive percentage number (`25`, `15`).
 */
export function parseSortableDiscount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /[-+]?\s*(\d+(?:\.\d+)?)\s*%/.exec(value);
  if (!match?.[1]) return null;
  const num = Number.parseFloat(match[1]);
  return Number.isFinite(num) ? Math.abs(num) : null;
}

function isMissingSortValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (typeof value === 'number' && !Number.isFinite(value)) return true;
  return false;
}

function compareFieldValues(
  colId: string,
  va: unknown,
  vb: unknown,
  desc: boolean,
): number {
  const dir = desc ? -1 : 1;

  if (colId === 'bestSellersRank') {
    const na = parseSortableBsrRank(va);
    const nb = parseSortableBsrRank(vb);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return (na - nb) * dir;
  }

  if (colId === 'pastMonthSales' || colId === 'soldCount') {
    const na = parseSortableSalesVolume(va);
    const nb = parseSortableSalesVolume(vb);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return (na - nb) * dir;
  }

  if (colId === 'discountPercentage') {
    const na = parseSortableDiscount(va);
    const nb = parseSortableDiscount(vb);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return (na - nb) * dir;
  }

  const aMissing = isMissingSortValue(va);
  const bMissing = isMissingSortValue(vb);
  if (aMissing && bMissing) return 0;
  // Missing values always sort to the end regardless of ascending/descending direction
  if (aMissing) return 1;
  if (bMissing) return -1;

  if (typeof va === 'number' && typeof vb === 'number') {
    return (va - vb) * dir;
  }

  if (typeof va === 'boolean' && typeof vb === 'boolean') {
    return (Number(va) - Number(vb)) * dir;
  }

  return (
    String(va).localeCompare(String(vb), undefined, {
      numeric: true,
      sensitivity: 'base',
    }) * dir
  );
}

/**
 * Sorts an array of Amazon or Temu products across 1..N sort columns (`SortingState`).
 * Preserves input order when `sorting` is empty and breaks ties using secondary/tertiary rules.
 */
export function sortProducts<T extends object>(
  products: readonly T[],
  sorting: SortingState,
): T[] {
  if (!sorting || sorting.length === 0 || products.length <= 1) {
    return [...products];
  }

  return [...products].sort((a, b) => {
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;

    for (const rule of sorting) {
      if (!rule?.id) continue;
      const cmp = compareFieldValues(
        rule.id,
        recA[rule.id],
        recB[rule.id],
        Boolean(rule.desc),
      );
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

/**
 * Toggles a column in a single-column or multi-column (`Shift+Click`) `SortingState`.
 * Matches existing TanStack Table default sort direction (`desc` first on numeric/boolean columns).
 */
export function toggleMultiColumnSort(
  current: SortingState,
  columnId: string,
  multi: boolean,
  defaultDesc = false,
): SortingState {
  const existingIdx = current.findIndex((s) => s.id === columnId);

  if (!multi) {
    if (existingIdx === 0 && current.length === 1) {
      const existing = current[0]!;
      // Cycle: initial direction -> opposite direction -> clear
      if (existing.desc === defaultDesc) {
        return [{ id: columnId, desc: !defaultDesc }];
      }
      return [];
    }
    return [{ id: columnId, desc: defaultDesc }];
  }

  // Multi-column (Shift+Click)
  if (existingIdx === -1) {
    return [...current, { id: columnId, desc: defaultDesc }];
  }

  const existing = current[existingIdx]!;
  if (existing.desc === defaultDesc) {
    const updated = [...current];
    updated[existingIdx] = { id: columnId, desc: !defaultDesc };
    return updated;
  }

  return current.filter((_, idx) => idx !== existingIdx);
}
