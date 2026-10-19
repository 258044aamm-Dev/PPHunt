/**
 * SAD-281 (P1.4) - the minimal end-to-end save pipeline.
 *
 * What this proves: a schema-valid product, a one-click collection and a History
 * row are written together; a repeat save refreshes instead of duplicating; a
 * failed write never reports success; and the collection pointer is honoured
 * only while its History row still exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import { getHistoryEntries } from '@/engines/amazon/db/history';
import { getProductCountBySession } from '@/engines/amazon/db/products';
import {
  ONE_CLICK_COLLECTION_STORAGE_KEY,
  readOneClickCollection,
  writeOneClickCollection,
} from '@/engines/amazon/db/one-click-state';
import {
  handleSaveProduct,
  isOneClickCollectionKey,
  resetSaveJobsForTests,
  resolveOneClickCollection,
  type SaveJobUpdate,
} from '@/engines/amazon/background/save-job';
import { validateExtensionMessage } from '@/engines/amazon/schemas/validate-message';
import type {
  SaveExtractionContext,
  ScrapedProduct,
} from '@/engines/amazon/types';

const PAGE_URL = 'https://www.amazon.com/s?k=widget';

function product(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: 'B08N5WRWNW',
    url: 'https://www.amazon.com/dp/B08N5WRWNW',
    title: 'Anker 65W Charger',
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 1200,
    source: 'search',
    ...overrides,
  };
}

function context(overrides: Partial<SaveExtractionContext> = {}): SaveExtractionContext {
  return {
    pageType: 'search',
    pageUrl: PAGE_URL,
    triggeredBy: 'context-menu',
    searchPosition: 3,
    listingCategory: 'organic',
    ...overrides,
  };
}

function payload(jobId: string, overrides: Partial<ScrapedProduct> = {}) {
  return { jobId, product: product(overrides), context: context() };
}

function storageStub() {
  const map = new Map<string, unknown>();
  const area = {
    get: vi.fn(async (key: string) =>
      map.has(key) ? { [key]: map.get(key) } : {},
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) map.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      map.delete(key);
    }),
  };

  (globalThis as unknown as { browser?: unknown }).browser = {
    storage: { local: area },
  };
  return { map, area };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetSaveJobsForTests();
  storageStub();
});

describe('handleSaveProduct', () => {
  it('writes the product, its snapshot and the History entry', async () => {
    const updates: SaveJobUpdate[] = [];
    const result = await handleSaveProduct(payload('job-1'), {
      emit: (update) => updates.push(update),
    });

    expect(result.state).toBe('completed');
    expect(isOneClickCollectionKey(result.collectionKey)).toBe(true);

    const rows = await db.products.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.asin).toBe('B08N5WRWNW');
    expect(rows[0]?.sessionKey).toBe(result.collectionKey);

    const snapshots = await db.snapshots.toArray();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.asin).toBe('B08N5WRWNW');
    expect(snapshots[0]?.jobId).toBe('job-1');
    expect(snapshots[0]?.source).toBe('listing');
    expect(snapshots[0]?.context?.searchPosition).toBe(3);

    const history = await getHistoryEntries();
    expect(history).toHaveLength(1);
    expect(history[0]?.origin).toBe('one-click');
    expect(history[0]?.collectedCount).toBe(1);
    expect(history[0]?.name).toBe(result.collectionLabel);

    expect(updates.map((u) => u.state)).toEqual(['extracting', 'completed']);
    expect(updates.at(-1)?.message).toMatch(/^Saved to .+ · 1 product$/);
  });

  it('reuses the current one-click collection for the next product', async () => {
    const first = await handleSaveProduct(payload('job-1'));
    const second = await handleSaveProduct(
      payload('job-2', { asin: 'B0SECONDAA', title: 'A Second Widget' }),
    );

    expect(second.state).toBe('completed');
    expect(second.collectionKey).toBe(first.collectionKey);
    expect(await getHistoryEntries()).toHaveLength(1);
    expect(await getProductCountBySession(first.collectionKey as string)).toBe(2);
    expect(second.message).toMatch(/2 products$/);
  });

  it('keeps one product row when the same ASIN is saved twice', async () => {
    await handleSaveProduct(payload('job-1'));
    await handleSaveProduct(payload('job-2', { price: 24.99 }));

    expect(await db.products.count()).toBe(1);
    expect(await db.snapshots.count()).toBe(2);

    const row = await db.products.toArray();
    expect(row[0]?.price).toBe(24.99);
  });

  it('refreshes the collection count from the database, not from a counter', async () => {
    const result = await handleSaveProduct(payload('job-1'));
    await handleSaveProduct(payload('job-2', { asin: 'B0SECONDAA' }));

    const history = await getHistoryEntries();
    expect(history[0]?.sessionKey).toBe(result.collectionKey);
    expect(history[0]?.collectedCount).toBe(2);
  });

  it('reports NO_PRODUCT, writes nothing and emits nothing when the ASIN is missing', async () => {
    const updates: SaveJobUpdate[] = [];
    const result = await handleSaveProduct(payload('job-1', { asin: '' }), {
      emit: (update) => updates.push(update),
    });

    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('NO_PRODUCT');
    // The wire format requires an ASIN; the content script reports this case.
    expect(updates).toHaveLength(0);
    expect(await db.products.count()).toBe(0);
    expect(await db.snapshots.count()).toBe(0);
    expect(await getHistoryEntries()).toHaveLength(0);
  });

  it('reports a failed write instead of a false success', async () => {
    const updates: SaveJobUpdate[] = [];
    const failure = vi
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error('QuotaExceededError'));

    const result = await handleSaveProduct(payload('job-1'), {
      emit: (update) => updates.push(update),
    });

    failure.mockRestore();

    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('DB_WRITE_FAILED');
    expect(updates.map((u) => u.state)).toEqual(['extracting', 'failed']);
    expect(await db.products.count()).toBe(0);
  });

  it('returns the running job for a duplicate save of the same product', async () => {
    const first = handleSaveProduct(payload('job-1'));
    const duplicate = await handleSaveProduct(payload('job-2'));

    expect(duplicate.jobId).toBe('job-1');
    expect(duplicate.message).toBe('Already saving');

    const firstResult = await first;
    expect(firstResult.state).toBe('completed');
    expect(await db.products.count()).toBe(1);
    expect(await db.snapshots.count()).toBe(1);
    expect(await getHistoryEntries()).toHaveLength(1);
  });

  it('allows a new extraction after the previous one finished', async () => {
    await handleSaveProduct(payload('job-1'));
    const second = await handleSaveProduct(payload('job-2', { price: 21.5 }));

    expect(second.jobId).toBe('job-2');
    expect(second.state).toBe('completed');
    expect(await db.products.count()).toBe(1);
    expect(await db.snapshots.count()).toBe(2);
  });

  it('ignores a second job with the same id while the first is running', async () => {
    const first = handleSaveProduct(payload('job-1'));
    const second = await handleSaveProduct(payload('job-1'));

    expect(second.message).toBe('Already saving');

    const firstResult = await first;
    expect(firstResult.state).toBe('completed');
    expect(await db.products.count()).toBe(1);
  });

  it('labels the snapshot source from the page type', async () => {
    await handleSaveProduct({
      jobId: 'job-detail',
      product: product({ asin: 'B0DETAILAA' }),
      context: context({ pageType: 'product-detail', pageUrl: 'https://www.amazon.com/dp/B0DETAILAA' }),
    });

    const snapshots = await db.snapshots.toArray();
    expect(snapshots[0]?.source).toBe('detail');
  });
});

describe('collection pointer', () => {
  it('stores where the next save should land', async () => {
    const result = await handleSaveProduct(payload('job-1'));
    const pointer = await readOneClickCollection();

    expect(pointer?.sessionKey).toBe(result.collectionKey);
    expect(pointer?.name).toBe(result.collectionLabel);
  });

  it('creates a new collection when the pointed-at row was deleted', async () => {
    const stored = {
      sessionKey: 'oc_1700000000000',
      name: 'Deleted collection',
      createdAt: '2026-10-19T10:00:00.000Z',
      updatedAt: '2026-10-19T10:00:00.000Z',
    };
    await writeOneClickCollection(stored);

    const resolved = await resolveOneClickCollection(PAGE_URL, {
      asin: 'B08N5WRWNW',
      title: 'Anker 65W Charger',
    });

    expect(resolved.created).toBe(true);
    expect(resolved.sessionKey).not.toBe(stored.sessionKey);
  });

  it('degrades to a fresh collection when storage is unavailable', async () => {
    (globalThis as unknown as { browser?: unknown }).browser = undefined;

    const resolved = await resolveOneClickCollection(PAGE_URL, {
      asin: 'B08N5WRWNW',
      title: 'Anker 65W Charger',
    });

    expect(resolved.created).toBe(true);
    expect(isOneClickCollectionKey(resolved.sessionKey)).toBe(true);
  });

  it('ignores a malformed pointer instead of failing the save', async () => {
    (globalThis as unknown as { browser?: unknown }).browser = {
      storage: {
        local: {
          get: vi.fn(async () => ({ [ONE_CLICK_COLLECTION_STORAGE_KEY]: { nope: true } })),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    };

    expect(await readOneClickCollection()).toBeNull();
    const result = await handleSaveProduct(payload('job-1'));
    expect(result.state).toBe('completed');
  });
});

describe('what the content script receives', () => {
  it('every emitted update survives the content-side message validator', async () => {
    const updates: SaveJobUpdate[] = [];
    await handleSaveProduct(payload('job-1'), {
      emit: (update) => updates.push(update),
    });

    for (const update of updates) {
      const outcome = validateExtensionMessage({
        type: 'SAVE_JOB_UPDATE',
        payload: update,
      });
      expect(outcome.status).toBe('valid');
    }
  });

  it('a failed update also validates, so the toast can report it', async () => {
    const updates: SaveJobUpdate[] = [];
    const failure = vi
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error('QuotaExceededError'));

    await handleSaveProduct(payload('job-1'), {
      emit: (update) => updates.push(update),
    });
    failure.mockRestore();

    const last = updates.at(-1);
    expect(last?.state).toBe('failed');

    const outcome = validateExtensionMessage({
      type: 'SAVE_JOB_UPDATE',
      payload: last,
    });
    expect(outcome.status).toBe('valid');
  });
});
