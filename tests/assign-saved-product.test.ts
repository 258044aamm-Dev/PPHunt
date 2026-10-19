/**
 * SAD-287 (P3.3) - "Ask every time" is persist-first, answer-second.
 *
 * The tests below all start from a completed save (behaviour `ask`), because
 * that is the only state in which the dialog exists. The two properties that
 * matter to the user are: a cancel or an unanswered dialog never removes the
 * History row, and "Create new collection" leaves nothing behind in the old
 * collection - no product copy, no orphan snapshot, no empty collection when it
 * fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import { getHistoryEntries } from '@/engines/amazon/db/history';
import { readOneClickCollection } from '@/engines/amazon/db/one-click-state';
import { updateSettings } from '@/engines/amazon/db/settings';
import {
  handleAssignSavedProduct,
  getPendingAssignment,
  pendingAssignmentCount,
  rememberPendingAssignment,
  resetPendingAssignmentsForTests,
} from '@/engines/amazon/background/assignment';
import {
  handleSaveProduct,
  resetSaveJobsForTests,
  type SaveJobUpdate,
} from '@/engines/amazon/background/save-job';
import type { ScrapedProduct } from '@/engines/amazon/types';

const PAGE_URL = 'https://www.amazon.com/s?k=charger';

function product(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: 'B08N5WRWNW',
    url: 'https://www.amazon.com/dp/B08N5WRWNW',
    title: 'Anker 65W Charger',
    price: 19.99,
    currency: 'USD',
    source: 'search',
    ...overrides,
  };
}

function storageStub() {
  const map = new Map<string, unknown>();
  (globalThis as unknown as { browser?: unknown }).browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) =>
          map.has(key) ? { [key]: map.get(key) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) map.set(key, value);
        }),
        remove: vi.fn(async (key: string) => {
          map.delete(key);
        }),
      },
    },
  };
  return map;
}

async function seedAskSave(jobId = 'job-ask') {
  await updateSettings({ quickSaveCollectionBehavior: 'ask' });
  const updates: SaveJobUpdate[] = [];
  const result = await handleSaveProduct(
    {
      jobId,
      product: product(),
      context: { pageType: 'search', pageUrl: PAGE_URL, triggeredBy: 'card-button' },
    },
    { emit: (update) => updates.push(update) },
  );
  return { result, updates };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetSaveJobsForTests();
  resetPendingAssignmentsForTests();
  storageStub();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pending assignment registry', () => {
  it('is populated by a save that needs a choice', async () => {
    const { result } = await seedAskSave('job-1');

    expect(result.state).toBe('completed');
    expect(result.requiresCollectionChoice).toBe(true);
    expect(result.productTitle).toBe('Anker 65W Charger');

    const entry = getPendingAssignment('job-1');
    expect(entry?.asin).toBe('B08N5WRWNW');
    expect(entry?.sessionKey).toBe(result.collectionKey);
    expect(entry?.label).toBe(result.collectionLabel);
  });

  it('is not populated for a save whose behaviour does not ask', async () => {
    await handleSaveProduct({
      jobId: 'job-2',
      product: product(),
      context: { pageType: 'search', pageUrl: PAGE_URL, triggeredBy: 'card-button' },
    });

    expect(pendingAssignmentCount()).toBe(0);
  });

  it('drops an entry that can no longer be answered', () => {
    rememberPendingAssignment({
      jobId: 'stale',
      asin: 'B08N5WRWNW',
      sessionKey: 'oc_1',
      label: 'Old',
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    expect(getPendingAssignment('stale')).toBeUndefined();
  });
});

describe('handleAssignSavedProduct', () => {
  it('choosing the current collection changes nothing', async () => {
    const { result } = await seedAskSave('job-current');
    const before = await readOneClickCollection();

    const updates: SaveJobUpdate[] = [];
    const update = await handleAssignSavedProduct(
      { jobId: 'job-current', choice: 'current' },
      { emit: (u) => updates.push(u) },
    );

    expect(update?.state).toBe('completed');
    expect(update?.collectionKey).toBe(result.collectionKey);
    expect(update?.message).toContain('Kept in');
    expect(updates).toHaveLength(1);

    const history = await getHistoryEntries();
    expect(history).toHaveLength(1);
    expect(history[0]?.sessionKey).toBe(result.collectionKey);
    expect(await db.products.count()).toBe(1);
    expect((await readOneClickCollection())?.sessionKey).toBe(before?.sessionKey);
    expect(pendingAssignmentCount()).toBe(0);
  });

  it('choosing a new collection moves the product and its snapshots', async () => {
    const { result } = await seedAskSave('job-new');
    const sourceKey = result.collectionKey as string;

    const update = await handleAssignSavedProduct({
      jobId: 'job-new',
      choice: 'new',
    });

    expect(update?.state).toBe('completed');
    expect(update?.collectionKey).toBeTruthy();
    expect(update?.collectionKey).not.toBe(sourceKey);
    expect(update?.message).toContain('Moved to');

    const history = await getHistoryEntries();
    expect(history).toHaveLength(2);
    const target = history.find((row) => row.sessionKey === update?.collectionKey);
    expect(target?.collectedCount).toBe(1);
    expect(target?.origin).toBe('one-click');

    const source = history.find((row) => row.sessionKey === sourceKey);
    expect(source?.collectedCount).toBe(0);

    expect(await db.products.where('sessionKey').equals(sourceKey).count()).toBe(0);
    const moved = await db.products
      .where('sessionKey')
      .equals(update?.collectionKey as string)
      .first();
    expect(moved?.asin).toBe('B08N5WRWNW');

    const snapshots = await db.snapshots.toArray();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((row) => row.sessionKey === update?.collectionKey)).toBe(true);

    // The new collection becomes the pointer, so the next save lands there.
    expect((await readOneClickCollection())?.sessionKey).toBe(update?.collectionKey);
  });

  it('cancelling (no message) leaves the row where it was saved', async () => {
    const { result } = await seedAskSave('job-cancel');

    // Cancel sends nothing at all - simulate the dialog closing and time passing.
    expect(await db.products.count()).toBe(1);
    const history = await getHistoryEntries();
    expect(history).toHaveLength(1);
    expect(history[0]?.sessionKey).toBe(result.collectionKey);
    expect(history[0]?.collectedCount).toBe(1);
  });

  it('ignores a stale job id', async () => {
    await seedAskSave('job-known');

    const update = await handleAssignSavedProduct({
      jobId: 'job-unknown',
      choice: 'new',
    });

    expect(update).toBeNull();
    expect(await getHistoryEntries()).toHaveLength(1);
  });

  it('cannot be answered twice', async () => {
    await seedAskSave('job-once');
    await handleAssignSavedProduct({ jobId: 'job-once', choice: 'new' });

    const second = await handleAssignSavedProduct({
      jobId: 'job-once',
      choice: 'new',
    });

    expect(second).toBeNull();
    expect(await getHistoryEntries()).toHaveLength(2);
  });

  it('reports a failure when the product is gone, without creating a collection', async () => {
    await seedAskSave('job-gone');
    await db.products.clear();

    const update = await handleAssignSavedProduct({
      jobId: 'job-gone',
      choice: 'new',
    });

    expect(update?.state).toBe('failed');
    expect(update?.errorCode).toBe('DB_WRITE_FAILED');
    expect(await getHistoryEntries()).toHaveLength(1);
  });

  it('discards the freshly created collection when the move fails', async () => {
    const { result } = await seedAskSave('job-broken');
    const sourceKey = result.collectionKey as string;

    const failing = () => {
      throw new Error('simulated snapshot failure');
    };
    db.snapshots.hook('updating', failing);

    try {
      const update = await handleAssignSavedProduct({
        jobId: 'job-broken',
        choice: 'new',
      });

      expect(update?.state).toBe('failed');

      const history = await getHistoryEntries();
      expect(history).toHaveLength(1);
      expect(history[0]?.sessionKey).toBe(sourceKey);
      expect(history[0]?.collectedCount).toBe(1);

      const row = await db.products
        .where('sessionKey')
        .equals(sourceKey)
        .first();
      expect(row?.asin).toBe('B08N5WRWNW');

      // The pointer is untouched, so the next save cannot land in a ghost.
      const pointer = await readOneClickCollection();
      expect(pointer?.sessionKey).toBe(sourceKey);
    } finally {
      db.snapshots.hook('updating').unsubscribe(failing);
    }
  });
});

describe('pointer after a move', () => {
  it('is left alone when the answer is "current"', async () => {
    await seedAskSave('job-repoint');
    const before = await readOneClickCollection();

    await handleAssignSavedProduct({ jobId: 'job-repoint', choice: 'current' });

    expect((await readOneClickCollection())?.sessionKey).toBe(before?.sessionKey);
  });
});
