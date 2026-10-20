/**
 * SAD-290 (P5.1) - the offscreen export builder.
 *
 * The builder is a transport shim around the existing CSV/XLSX writers, so the
 * tests check exactly that: the bytes decode to the same file the panel export
 * would produce, a missing value stays blank (never a placeholder), the image
 * budget is honoured, and the request guard rejects anything a worker should not
 * have sent.
 */
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import {
  MAX_EXPORT_ROWS,
  OFFSCREEN_TARGET,
  isOffscreenRequest,
  type OffscreenBuildExportRequest,
} from '@/engines/amazon/offscreen/protocol';
import { buildExportFile } from '@/engines/amazon/offscreen/export-build';
import { handleOffscreenRequest } from '@/engines/amazon/offscreen/handlers';
import type { AmazonProduct } from '@/engines/amazon/types/product';

type ExportFixture = AmazonProduct & {
  snapshotCount?: number | null;
  lastSnapshotAt?: string | null;
};

function product(overrides: Partial<ExportFixture> = {}): ExportFixture {
  return {
    asin: 'B08N5WRWNW',
    url: 'https://www.amazon.com/dp/B08N5WRWNW',
    title: 'Anker 65W Charger',
    price: 19.99,
    currency: 'USD',
    source: 'search',
    collectedAt: '2026-10-19T09:00:00.000Z',
    sessionKey: 'oc_1',
    ...overrides,
  } as ExportFixture;
}

function request(
  overrides: Partial<OffscreenBuildExportRequest> = {},
): OffscreenBuildExportRequest {
  return {
    target: OFFSCREEN_TARGET,
    type: 'OFFSCREEN_BUILD_EXPORT',
    format: 'csv',
    products: [product()],
    columns: ['ASIN', 'Title', 'Price'],
    filename: 'pphunt-amazon-2026-10-19-001',
    includeBOM: true,
    embedImages: 'never',
    ...overrides,
  };
}

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function text(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

describe('CSV bytes', () => {
  it('returns a UTF-8 file with the header and one row per product', async () => {
    const result = await buildExportFile(
      request({
        products: [
          product(),
          product({ asin: 'B000000001', title: 'Second', price: null }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const csv = text(result.base64);
    const lines = csv.replace(/^\uFEFF/, '').split('\n');
    expect(lines[0]).toBe('ASIN,Title,Price');
    expect(lines[1]).toBe('B08N5WRWNW,Anker 65W Charger,19.99');
    expect(lines[2]).toBe('B000000001,Second,');
    expect(result.mimeType).toBe('text/csv;charset=utf-8');
    expect(result.filename).toBe('pphunt-amazon-2026-10-19-001.csv');
    expect(result.count).toBe(2);
  });

  it('writes a BOM only when asked', async () => {
    const withBom = await buildExportFile(request({ includeBOM: true }));
    const withoutBom = await buildExportFile(request({ includeBOM: false }));

    expect(withBom.ok && withoutBom.ok).toBe(true);
    if (!withBom.ok || !withoutBom.ok) return;

    const bomBytes = decode(withBom.base64);
    expect(Array.from(bomBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(withoutBom.base64).startsWith('\uFEFF')).toBe(false);
    // The BOM adds exactly three bytes, nothing else changes.
    expect(bomBytes.byteLength).toBe(
      decode(withoutBom.base64).byteLength + 3,
    );
  });

  it('leaves unavailable values blank, except Coupon which shows No (SAD-348)', async () => {
    const result = await buildExportFile(
      request({
        columns: ['ASIN', 'Coupon', 'Best Sellers Rank', 'Snapshot Count'],
        products: [
          product({
            coupon: null,
            bestSellersRank: null,
            snapshotCount: null,
          }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(text(result.base64).replace(/^\uFEFF/, '').split('\n')[1]).toBe(
      'B08N5WRWNW,No,,',
    );
  });
});

describe('XLSX bytes', () => {
  it('produces a workbook named Products with the requested headers', async () => {
    const result = await buildExportFile(
      request({
        format: 'xlsx',
        columns: ['ASIN', 'Title', 'Price', 'Snapshot Count'],
        products: [
          product({ snapshotCount: 3 }),
          product({ asin: 'B000000001', title: 'Second', price: null }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const workbook = XLSX.read(decode(result.base64), { type: 'array' });
    expect(workbook.SheetNames).toEqual(['Products']);

    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets.Products!,
      { header: 1 },
    );
    expect(rows[0]).toEqual(['ASIN', 'Title', 'Price', 'Snapshot Count']);
    expect(rows[1]?.[0]).toBe('B08N5WRWNW');
    // The shared XLSX writer materialises every column as text (same as the
    // panel export); the value is the stored count, not a formatted label.
    expect(rows[1]?.[3]).toBe('3');
    // Blank, not 0/undefined-as-text: the cell is simply absent.
    expect(rows[2]?.[2] ?? '').toBe('');
    expect(result.filename).toBe('pphunt-amazon-2026-10-19-001.xlsx');
  });

  it('respects the image budget: never means no fetch at all', async () => {
    const fetchImage = vi.fn(async () => null);

    const result = await buildExportFile(
      request({
        format: 'xlsx',
        columns: ['ASIN', 'Image'],
        embedImages: 'never',
        products: [
          product({ imageUrl: 'https://m.media-amazon.com/images/I/x.jpg' }),
        ],
      }),
      { fetchImage },
    );

    expect(result.ok).toBe(true);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('fetches an image when the mode asks for it and skips rows without a URL', async () => {
    const fetchImage = vi.fn(async () => null);

    const result = await buildExportFile(
      request({
        format: 'xlsx',
        columns: ['ASIN', 'Image'],
        embedImages: 'always',
        products: [
          product({ imageUrl: 'https://m.media-amazon.com/images/I/x.jpg' }),
          product({ asin: 'B000000001', imageUrl: null }),
        ],
      }),
      { fetchImage },
    );

    expect(result.ok).toBe(true);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });
});

describe('a 50-product collection', () => {
  const rows = Array.from({ length: 50 }, (_, index) =>
    product({
      asin: `B00000${String(index).padStart(4, '0')}`,
      title: `Product ${index}`,
      price: index % 5 === 0 ? null : 10 + index,
      coupon: index % 7 === 0 ? '10% off' : null,
      snapshotCount: index,
    }),
  );

  it('exports CSV with every row, blanks left blank except Coupon which shows No (SAD-348)', async () => {
    const result = await buildExportFile(
      request({ columns: ['ASIN', 'Price', 'Coupon'], products: rows }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lines = text(result.base64).replace(/^\uFEFF/, '').split('\n');
    expect(lines).toHaveLength(51);
    expect(lines[1]).toBe('B000000000,,10% off');
    expect(lines[2]).toBe('B000000001,11,No');
  });

  it('exports XLSX with every row', async () => {
    const result = await buildExportFile(
      request({ format: 'xlsx', columns: ['ASIN', 'Price'], products: rows }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const workbook = XLSX.read(decode(result.base64), { type: 'array' });
    const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets.Products!,
      { header: 1 },
    );
    // Header + 50 data rows.
    expect(sheetRows).toHaveLength(51);
    expect(result.count).toBe(50);
  });
});

describe('request guard', () => {
  it('accepts a well formed build request', () => {
    expect(isOffscreenRequest(request())).toBe(true);
  });

  it('rejects an unknown format, empty filename or bad flag', () => {
    expect(isOffscreenRequest({ ...request(), format: 'pdf' })).toBe(false);
    expect(isOffscreenRequest({ ...request(), filename: '   ' })).toBe(false);
    expect(isOffscreenRequest({ ...request(), includeBOM: 'yes' })).toBe(false);
    expect(
      isOffscreenRequest({ ...request(), embedImages: 'sometimes' }),
    ).toBe(false);
  });

  it('rejects a runaway collection and non-object rows', () => {
    const tooMany = new Array(MAX_EXPORT_ROWS + 1).fill({ asin: 'A' });
    expect(isOffscreenRequest({ ...request(), products: tooMany })).toBe(false);
    expect(isOffscreenRequest({ ...request(), products: ['nope'] })).toBe(false);
    expect(isOffscreenRequest({ ...request(), columns: [1, 2] })).toBe(false);
  });

  it('is dispatched by the offscreen handler', async () => {
    const response = await handleOffscreenRequest(request());
    expect(response).toMatchObject({ ok: true, count: 1 });
  });
});
