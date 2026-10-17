/**
 * Step 8.3 (SAD-192) — M-6: bounded image embedding.
 *
 * 'auto' (default) embeds images only within the decision-D4 budgets
 * (≤ 200 products, ≤ 25 MB running total, < 20 s wall clock — shrinkable
 * via the test-only `budgets` seam). 'always' overrides, 'never' never
 * fetches. Every breach degrades gracefully to the URL text the exporter
 * already writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { db } from '@/lib/db/database';
import type { Product } from '@/types/product';
import {
  buildExcelWorkbookBuffer,
  resolveEmbedImages,
  AUTO_MAX_PRODUCTS,
} from '@/lib/export/excel';
import { SettingsSchema } from '@/lib/schemas/settings';
import { DEFAULT_VISIBLE_COLUMNS } from '@/lib/export/types';

const { exportExcelMock } = vi.hoisted(() => ({
  exportExcelMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/export/excel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/excel')>();
  return { ...actual, exportExcel: exportExcelMock };
});

// Imported after the mock is registered so the component graph picks it up.
import { ExportModal } from '@/entrypoints/sidepanel/components/ExportModal';

/** Minimal valid PNG header bytes — enough for detectImageExtension. */
function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

function makeProducts(count: number): Product[] {
  return Array.from({ length: count }, (_, i) => ({
    asin: `B0BUDG${String(i).padStart(4, '0')}`,
    url: `https://www.amazon.com/dp/B0BUDG${String(i).padStart(4, '0')}`,
    title: `Budget Product ${i}`,
    price: 9.99,
    currency: 'USD',
    imageUrl: `https://m.media-amazon.com/images/I/budget${i}.png`,
    description: null,
    features: [],
    source: 'search' as const,
    collectedAt: '2026-10-17T00:00:00.000Z',
    sessionKey: 'session-budgets',
  }));
}

/** Reads the Image-column value of data row `rowIdx` (1-based data rows). */
function imageColumnValues(bytes: Uint8Array, rowCount: number): unknown[] {
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheet = wb.Sheets['Products'];
  if (!sheet) throw new Error('Products sheet missing');
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  let imageCol = -1;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const header = sheet[XLSX.utils.encode_cell({ r: 0, c })];
    if (header?.v === 'Image') imageCol = c;
  }
  expect(imageCol).toBeGreaterThanOrEqual(0);
  const values: unknown[] = [];
  for (let r = 1; r <= rowCount; r++) {
    values.push(sheet[XLSX.utils.encode_cell({ r, c: imageCol })]?.v);
  }
  return values;
}

function countMediaParts(bytes: Uint8Array): number {
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  let count = 0;
  for (let i = 1; i <= 1000; i++) {
    if (XLSX.CFB.find(cfb, `/xl/media/image${i}.png`)) count += 1;
    else break;
  }
  return count;
}

describe('resolveEmbedImages (decision D4)', () => {
  it('auto embeds at/below 200 products, refuses above; always/never override', () => {
    expect(resolveEmbedImages('auto', 200)).toBe(true);
    expect(resolveEmbedImages('auto', 201)).toBe(false);
    expect(resolveEmbedImages('auto', AUTO_MAX_PRODUCTS)).toBe(true);
    expect(resolveEmbedImages('always', 100_000)).toBe(true);
    expect(resolveEmbedImages('never', 1)).toBe(false);
  });
});

describe('XLSX image budgets (M-6 / SAD-192)', () => {
  it("'auto' with 201 products fetches nothing and writes URL text", async () => {
    const products = makeProducts(201);
    const fetcher = vi
      .fn<(url: string) => Promise<{ bytes: Uint8Array; contentType?: string | null } | null>>()
      .mockResolvedValue({ bytes: pngBytes(64), contentType: 'image/png' });

    const bytes = await buildExcelWorkbookBuffer(products, DEFAULT_VISIBLE_COLUMNS, {
      fetchImage: fetcher,
      // embedImages omitted → 'auto' default
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(countMediaParts(bytes)).toBe(0);
    const values = imageColumnValues(bytes, 201);
    expect(values[0]).toBe('https://m.media-amazon.com/images/I/budget0.png');
    expect(values[200]).toBe('https://m.media-amazon.com/images/I/budget200.png');
  }, 30_000);

  it("'always' overrides the product budget and fetches all 300", async () => {
    const products = makeProducts(300);
    const fetcher = vi
      .fn<(url: string) => Promise<{ bytes: Uint8Array; contentType?: string | null } | null>>()
      .mockResolvedValue({ bytes: pngBytes(64), contentType: 'image/png' });

    const bytes = await buildExcelWorkbookBuffer(products, DEFAULT_VISIBLE_COLUMNS, {
      embedImages: 'always',
      fetchImage: fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(300);
    expect(countMediaParts(bytes)).toBe(300);
  }, 60_000);

  it("'never' fetches nothing and produces no /xl/media parts", async () => {
    const products = makeProducts(3);
    const fetcher = vi.fn();

    const bytes = await buildExcelWorkbookBuffer(products, DEFAULT_VISIBLE_COLUMNS, {
      embedImages: 'never',
      fetchImage: fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(countMediaParts(bytes)).toBe(0);
  });

  it('auto: the byte budget stops embedding mid-export; earlier rows stay embedded', async () => {
    const products = makeProducts(4);
    // 5 MB per image with a 12 MB cap → exactly two fit (5+5 ≤ 12 < 5+5+5).
    const fetcher = vi
      .fn<(url: string) => Promise<{ bytes: Uint8Array; contentType?: string | null } | null>>()
      .mockResolvedValue({
        bytes: pngBytes(5 * 1024 * 1024),
        contentType: 'image/png',
      });

    const bytes = await buildExcelWorkbookBuffer(products, DEFAULT_VISIBLE_COLUMNS, {
      // 'auto' with a shrunken byte budget via the test seam
      budgets: { maxTotalBytes: 12 * 1024 * 1024 },
      fetchImage: fetcher,
    });

    expect(countMediaParts(bytes)).toBe(2);
    // Rows past the cap degrade to URL text — no throw, export succeeds.
    const values = imageColumnValues(bytes, 4);
    expect(values[2]).toBe('https://m.media-amazon.com/images/I/budget2.png');
    expect(values[3]).toBe('https://m.media-amazon.com/images/I/budget3.png');
  }, 30_000);

  it('auto: a stalled image server cannot outlast the wall-clock budget', async () => {
    const products = makeProducts(3);
    const stalled = vi.fn(() => new Promise<never>(() => {})); // never resolves

    const startedAt = Date.now();
    const bytes = await buildExcelWorkbookBuffer(products, DEFAULT_VISIBLE_COLUMNS, {
      budgets: { maxWallMs: 200 },
      fetchImage: stalled,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(3000);
    expect(countMediaParts(bytes)).toBe(0);
    const values = imageColumnValues(bytes, 3);
    expect(values.every((v) => typeof v === 'string' && v.startsWith('https://'))).toBe(
      true
    );
  }, 15_000);

  it('reports progress via onProgress for the modal', async () => {
    const products = makeProducts(4);
    const progress: Array<[number, number]> = [];
    await buildExcelWorkbookBuffer(products, DEFAULT_VISIBLE_COLUMNS, {
      embedImages: 'always',
      fetchImage: async () => ({ bytes: pngBytes(64), contentType: 'image/png' }),
      onProgress: (fetched, total) => progress.push([fetched, total]),
    });
    expect(progress.length).toBe(4);
    expect(progress[progress.length - 1]).toEqual([4, 4]);
  });
});

describe('exportImages setting persistence (SAD-192)', () => {
  beforeEach(async () => {
    await db.open();
    await db.settings.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to 'auto' for databases created before the field existed, and round-trips 'never'", async () => {
    // A row parsed from a legacy payload (no exportImages key) gains the default.
    const legacy = SettingsSchema.parse({ defaultMode: 'manual' });
    expect(legacy.exportImages).toBe('auto');

    await db.settings.put(SettingsSchema.parse({ ...legacy, exportImages: 'never' }));
    const stored = await db.settings.get('default');
    expect(stored?.exportImages).toBe('never');
  });

  it('ExportModal: the per-export override wins over the persisted default without mutating it', async () => {
    // Persisted default: never embed, excel format.
    await db.settings.put(
      SettingsSchema.parse({ exportFormat: 'excel', exportImages: 'never' })
    );

    const products = makeProducts(2);
    render(
      <ExportModal
        isOpen
        onClose={() => {}}
        allProducts={products}
        selectedProducts={[]}
        filteredProducts={products}
        hasFilter={false}
        hasSelection={false}
      />
    );

    // Seeded from the persisted default: Never is the pressed option.
    await waitFor(() => {
      expect(screen.getByText('Never').getAttribute('aria-pressed')).toBe('true');
    });

    // Override for this export only.
    fireEvent.click(screen.getByText('Always'));
    expect(screen.getByText('Always').getAttribute('aria-pressed')).toBe('true');

    exportExcelMock.mockClear();
    fireEvent.click(screen.getByText(`Export ${products.length} products`));

    await waitFor(() => {
      expect(exportExcelMock).toHaveBeenCalledTimes(1);
    });
    const options = exportExcelMock.mock.calls[0]![3] as {
      embedImages?: string;
    };
    expect(options.embedImages).toBe('always');

    // The persisted default is untouched.
    const stored = await db.settings.get('default');
    expect(stored?.exportImages).toBe('never');
  });
});
