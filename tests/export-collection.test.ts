/**
 * SAD-290 (P5.1) - one collection, one file.
 *
 * The worker owns the read: rows come out of IndexedDB, gain their snapshot
 * statistics, and are handed to the offscreen builder as plain objects. These
 * tests pin the join (counts and latest capture per ASIN), the column set (the
 * shared settings columns plus the two snapshot columns, nothing invented), and
 * the failure modes a caller has to distinguish.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import { DEFAULT_AMAZON_SETTINGS } from '@/engines/amazon/constants/defaults';
import {
  buildCollectionExport,
  loadCollectionForExport,
} from '@/engines/amazon/background/export-collection';
import { getExportColumnsFromSettings } from '@/engines/amazon/export/types';
import type { AmazonSettings } from '@/engines/amazon/types';

const SESSION = 'oc_1';

function product(asin: string, collectedAt: string) {
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: `Product ${asin}`,
    price: 10,
    currency: 'USD',
    source: 'search' as const,
    collectedAt,
    sessionKey: SESSION,
  };
}

function snapshotRow(asin: string, capturedAt: string, jobId: string) {
  return {
    asin,
    sessionKey: SESSION,
    jobId,
    source: 'listing' as const,
    capturedAt,
    price: 10,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 100,
  };
}

const settings = {
  ...DEFAULT_AMAZON_SETTINGS,
  exportFilename: '',
  includeBOM: true,
  exportImages: 'auto',
} as AmazonSettings;

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('loadCollectionForExport', () => {
  it('joins the snapshot count and the latest capture per ASIN', async () => {
    await db.products.bulkAdd([
      product('B000000002', '2026-10-19T09:05:00.000Z'),
      product('B000000001', '2026-10-19T09:00:00.000Z'),
    ]);
    await db.snapshots.bulkAdd([
      snapshotRow('B000000001', '2026-10-19T09:00:00.000Z', 'job-1'),
      snapshotRow('B000000001', '2026-10-19T09:30:00.000Z', 'job-2'),
      snapshotRow('B000000002', '2026-10-19T09:05:00.000Z', 'job-3'),
    ]);

    const rows = await loadCollectionForExport(SESSION);

    expect(rows.map((row) => row.asin)).toEqual(['B000000001', 'B000000002']);
    expect(rows[0]).toMatchObject({
      snapshotCount: 2,
      lastSnapshotAt: '2026-10-19T09:30:00.000Z',
    });
    expect(rows[1]).toMatchObject({
      snapshotCount: 1,
      lastSnapshotAt: '2026-10-19T09:05:00.000Z',
    });
  });

  it('keeps a product that has no snapshots (0, null - not missing)', async () => {
    await db.products.add(product('B000000003', '2026-10-19T09:00:00.000Z'));

    const rows = await loadCollectionForExport(SESSION);

    expect(rows[0]?.snapshotCount).toBe(0);
    expect(rows[0]?.lastSnapshotAt).toBeNull();
  });

  it('never mixes in another collection', async () => {
    await db.products.bulkAdd([
      product('B000000001', '2026-10-19T09:00:00.000Z'),
      { ...product('B000000009', '2026-10-19T09:00:00.000Z'), sessionKey: 'oc_2' },
    ]);

    const rows = await loadCollectionForExport(SESSION);

    expect(rows.map((row) => row.asin)).toEqual(['B000000001']);
  });
});

describe('buildCollectionExport', () => {
  it('asks the offscreen builder for the settings columns plus snapshot columns', async () => {
    const send = vi.fn(async (input: { columns: string[]; filename: string; format: string; includeBOM: boolean; embedImages: string }) => ({
      ok: true as const,
      base64: 'AAAA',
      mimeType: 'text/csv;charset=utf-8',
      filename: 'pphunt-amazon-2026-10-19-001-writing-tools.csv',
      byteLength: 3,
      count: 1,
    }));

    const result = await buildCollectionExport(
      {
        sessionKey: SESSION,
        format: 'csv',
        label: 'Writing Tools',
        date: new Date('2026-10-19T10:00:00.000Z'),
      },
      {
        load: async () => [
          {
            ...product('B000000001', '2026-10-19T09:00:00.000Z'),
            snapshotCount: 2,
            lastSnapshotAt: '2026-10-19T09:30:00.000Z',
          },
        ],
        send,
        settings,
      },
    );

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0]![0];
    expect(request.format).toBe('csv');
    expect(request.filename).toBe('pphunt-amazon-2026-10-19-001-writing-tools');
    expect(request.includeBOM).toBe(true);
    expect(request.embedImages).toBe('auto');
    expect(request.columns).toContain('ASIN');
    expect(request.columns).toContain('Snapshot Count');
    expect(request.columns).toContain('Last Snapshot');
    // The panel's column set is untouched by this feature: the request is
    // exactly the settings-derived columns plus the two snapshot columns
    // (which now include Description/Features, default-on since SAD-333).
    expect(request.columns).toEqual([
      ...getExportColumnsFromSettings(settings.enabledFields),
      'Snapshot Count',
      'Last Snapshot',
    ]);
    if (result.ok) {
      expect(result.count).toBe(1);
      expect(result.filename).toMatch(/\.csv$/);
    }
  });

  it('refuses to build an empty file', async () => {
    const send = vi.fn();

    const result = await buildCollectionExport(
      { sessionKey: SESSION, format: 'csv' },
      { load: async () => [], send, settings },
    );

    expect(result).toMatchObject({ ok: false, code: 'EXPORT_INVALID' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a failed read without pretending the collection is empty', async () => {
    const result = await buildCollectionExport(
      { sessionKey: SESSION, format: 'csv' },
      {
        load: async () => {
          throw new Error('database is closed');
        },
        send: vi.fn(),
        settings,
      },
    );

    expect(result).toMatchObject({ ok: false, code: 'DB_READ_FAILED' });
  });

  it('maps a transport failure onto a stable code', async () => {
    const tooLarge = await buildCollectionExport(
      { sessionKey: SESSION, format: 'xlsx' },
      {
        load: async () => [
          {
            ...product('B000000001', '2026-10-19T09:00:00.000Z'),
            snapshotCount: 0,
            lastSnapshotAt: null,
          },
        ],
        send: async () => ({
          ok: false as const,
          code: 'EXPORT_TOO_LARGE' as const,
          message: 'too big',
        }),
        settings,
      },
    );
    expect(tooLarge).toMatchObject({ ok: false, code: 'EXPORT_TOO_LARGE' });

    const unknown = await buildCollectionExport(
      { sessionKey: SESSION, format: 'xlsx' },
      {
        load: async () => [
          {
            ...product('B000000001', '2026-10-19T09:00:00.000Z'),
            snapshotCount: 0,
            lastSnapshotAt: null,
          },
        ],
        send: async () => ({
          ok: false as const,
          code: 'BLOB_FAILED' as const,
          message: 'no document',
        }),
        settings,
      },
    );
    expect(unknown).toMatchObject({ ok: false, code: 'EXPORT_BUILD_FAILED' });
  });

  it('reads the real settings when none are injected', async () => {
    const send = vi.fn(async (input: { includeBOM: boolean; embedImages: string }) => ({
      ok: true as const,
      base64: '',
      mimeType: 'text/csv;charset=utf-8',
      filename: 'x.csv',
      byteLength: 0,
      count: 1,
    }));

    await buildCollectionExport(
      { sessionKey: SESSION, format: 'csv' },
      {
        load: async () => [
          {
            ...product('B000000001', '2026-10-19T09:00:00.000Z'),
            snapshotCount: 0,
            lastSnapshotAt: null,
          },
        ],
        send,
      },
    );

    expect(send.mock.calls[0]![0].includeBOM).toBe(
      DEFAULT_AMAZON_SETTINGS.includeBOM,
    );
    expect(send.mock.calls[0]![0].embedImages).toBe(
      DEFAULT_AMAZON_SETTINGS.exportImages,
    );
  });
});
