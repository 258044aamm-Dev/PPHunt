/**
 * L-4 (SAD-196): O(1) row numbering via row.getDisplayIndex().
 *
 * Semantic (documented in columns.tsx): the '#' column shows the POSITION IN
 * THE CURRENT VIEW — it renumbers under sort, filter, and delete (the
 * semantic the SAD-139 suite encodes). These tests cover the three
 * interactions the issue calls out explicitly; the pre-existing
 * preview-images-rownumbers-export suite covers add/sort-by-title/filter/
 * delete and must keep passing unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import { db } from '@/lib/db/database';

// jsdom has no layout engine — the virtualizer would render zero rows.
// Same mock the SAD-139 suite uses.
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

const SESSION = 'session-rownums';

async function seedProducts() {
  const base = {
    currency: 'USD',
    rating: 4.0,
    reviewCount: 10,
    brand: 'B',
    seller: 'Amazon',
    availability: 'In Stock',
    isSponsored: false,
    isPrime: false,
    imageUrl: null,
    description: null,
    features: [],
    source: 'search' as const,
    collectedAt: '2026-10-16T12:00:00.000Z',
    pageUrl: 'https://www.amazon.com/s?k=test',
    sessionKey: SESSION,
  };
  await db.products.bulkAdd([
    { ...base, asin: 'B0RN000001', title: 'Alpha Widget', price: 10, url: 'https://www.amazon.com/dp/B0RN000001' },
    { ...base, asin: 'B0RN000002', title: 'Bravo Widget', price: 30, url: 'https://www.amazon.com/dp/B0RN000002' },
    { ...base, asin: 'B0RN000003', title: 'Charlie Gadget', price: 20, url: 'https://www.amazon.com/dp/B0RN000003' },
  ]);
}

function rowNumbers(): (string | null)[] {
  return screen.getAllByTestId('table-row-number').map((el) => el.textContent);
}

describe('O(1) row numbering (SAD-196 / L-4)', () => {
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
    await seedProducts();
  });

  afterEach(cleanup);

  it('sort by price descending -> row numbers are 1..N in view order', async () => {
    render(<ProductTable fullHeight sessionKey={SESSION} />);
    await waitFor(() => expect(rowNumbers()).toEqual(['1', '2', '3']));

    // Verified against the real header behaviour: the first click on Price
    // sorts DESCENDING ($30 first).
    const priceHeader = screen.getByText('Price');
    fireEvent.click(priceHeader);
    await waitFor(() => {
      const bodyRows = Array.from(document.querySelectorAll('tbody tr'));
      expect(bodyRows[0]?.textContent).toContain('Bravo Widget'); // $30
      expect(bodyRows[1]?.textContent).toContain('Charlie Gadget'); // $20
      expect(bodyRows[2]?.textContent).toContain('Alpha Widget'); // $10
      expect(rowNumbers()).toEqual(['1', '2', '3']);
    });
  });

  it('filter to a subset -> contiguous 1..M, no gaps, no duplicates', async () => {
    render(<ProductTable fullHeight sessionKey={SESSION} />);
    await waitFor(() => expect(rowNumbers()).toEqual(['1', '2', '3']));

    const searchInput = screen.getByPlaceholderText(/filter/i);

    // Two-row subset: 'Widget' matches Alpha + Bravo (Charlie is a Gadget).
    fireEvent.change(searchInput, { target: { value: 'Widget' } });
    await waitFor(() => {
      const nums = rowNumbers();
      expect(nums).toEqual(['1', '2']);
      expect(new Set(nums).size).toBe(nums.length); // no duplicates
    });

    // Single-row subset.
    fireEvent.change(searchInput, { target: { value: 'ravo' } });
    await waitFor(() => expect(rowNumbers()).toEqual(['1']));
  });

  it('delete a row mid-table -> numbers re-flow with no gap', async () => {
    render(<ProductTable fullHeight sessionKey={SESSION} />);
    await waitFor(() => expect(rowNumbers()).toEqual(['1', '2', '3']));

    // Delete the middle row (Bravo).
    const middle = await db.products.where('asin').equals('B0RN000002').first();
    expect(middle?.id).toBeDefined();
    await db.products.delete(middle!.id!);

    await waitFor(() => expect(rowNumbers()).toEqual(['1', '2']));
    const bodyRows = Array.from(document.querySelectorAll('tbody tr'));
    expect(bodyRows.some((r) => r.textContent?.includes('Bravo Widget'))).toBe(false);
  });

  it('row-number cell no longer scans the row model (no findIndex hot path)', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'entrypoints', 'sidepanel', 'table', 'columns.tsx'),
      'utf8'
    );
    expect(src).toContain('getDisplayIndex');
    expect(src).not.toContain('findIndex');
  });
});
