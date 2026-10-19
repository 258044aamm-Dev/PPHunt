/**
 * SAD-287 (P3.3) - the cross-collection move behind "Create new collection".
 *
 * What has to be true, and is asserted here:
 *   1. the product row and every snapshot of that ASIN land in the target;
 *   2. both History counts are recomputed in the same write;
 *   3. other products and other collections are untouched;
 *   4. a failure anywhere inside the transaction leaves the row in the source
 *      (this is what makes the dialog's Cancel and its failure path safe).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import {
  CollectionMoveError,
  discardCollection,
  moveProductToCollection,
} from '@/engines/amazon/db/product-assignment';

const SOURCE = 'oc_1760000000000';
const TARGET = 'oc_1760000000500';
const NOW = new Date('2026-10-19T12:00:00.000Z');

function historyRow(sessionKey: string, label: string) {
  return {
    sessionKey,
    url: 'https://www.amazon.com/s?k=charger',
    mode: 'manual' as const,
    targetCount: 0,
    collectedCount: 0,
    startedAt: '2026-10-19T11:00:00.000Z',
    completedAt: '2026-10-19T11:00:00.000Z',
    updatedAt: '2026-10-19T11:00:00.000Z',
    status: 'completed' as const,
    name: label,
    origin: 'one-click' as const,
  };
}

function storedProduct(asin: string, sessionKey: string) {
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: `Product ${asin}`,
    collectedAt: '2026-10-19T11:00:01.000Z',
    sessionKey,
    source: 'search' as const,
    price: 19.99,
    currency: 'USD',
  };
}

function snapshot(asin: string, sessionKey: string, capturedAt: string) {
  return {
    asin,
    sessionKey,
    jobId: `job-${capturedAt}`,
    source: 'listing' as const,
    capturedAt,
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 120,
  };
}

async function seed() {
  await db.history.bulkAdd([
    historyRow(SOURCE, 'Chargers'),
    historyRow(TARGET, 'Anker 65W'),
  ]);
  await db.products.bulkAdd([
    storedProduct('B08N5WRWNW', SOURCE),
    storedProduct('B0OTHERVAL', SOURCE),
    storedProduct('B0THIRDAAA', TARGET),
  ]);
  await db.snapshots.bulkAdd([
    snapshot('B08N5WRWNW', SOURCE, '2026-10-19T11:00:02.000Z'),
    snapshot('B08N5WRWNW', SOURCE, '2026-10-19T11:30:02.000Z'),
    snapshot('B0OTHERVAL', SOURCE, '2026-10-19T11:00:02.000Z'),
  ]);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moveProductToCollection', () => {
  it('moves the product and every snapshot of that ASIN', async () => {
    const result = await moveProductToCollection({
      asin: 'B08N5WRWNW',
      fromSessionKey: SOURCE,
      toSessionKey: TARGET,
      now: NOW,
    });

    expect(result).toEqual({
      moved: true,
      snapshotCount: 2,
      fromCount: 1,
      toCount: 2,
    });

    const moved = await db.products
      .where('[sessionKey+asin]')
      .equals([TARGET, 'B08N5WRWNW'])
      .first();
    expect(moved?.title).toBe('Product B08N5WRWNW');

    const snapshots = await db.snapshots.toArray();
    expect(snapshots).toHaveLength(3);
    expect(snapshots.filter((row) => row.sessionKey === TARGET)).toHaveLength(2);
    expect(snapshots.filter((row) => row.asin === 'B0OTHERVAL')[0]?.sessionKey).toBe(
      SOURCE,
    );
  });

  it('updates both History counts in the same write', async () => {
    await moveProductToCollection({
      asin: 'B08N5WRWNW',
      fromSessionKey: SOURCE,
      toSessionKey: TARGET,
      now: NOW,
    });

    const source = await db.history.where('sessionKey').equals(SOURCE).first();
    const target = await db.history.where('sessionKey').equals(TARGET).first();

    expect(source?.collectedCount).toBe(1);
    expect(target?.collectedCount).toBe(2);
    expect(target?.updatedAt).toBe(NOW.toISOString());
  });

  it('is a no-op when source and target are the same collection', async () => {
    const result = await moveProductToCollection({
      asin: 'B08N5WRWNW',
      fromSessionKey: SOURCE,
      toSessionKey: SOURCE,
      now: NOW,
    });

    expect(result.moved).toBe(false);
    expect(result.fromCount).toBe(2);
    expect(result.toCount).toBe(2);
    expect(await db.snapshots.where('sessionKey').equals(SOURCE).count()).toBe(3);
  });

  it('reports moved:false when the product is not in the source', async () => {
    const result = await moveProductToCollection({
      asin: 'B0NOTHEREXX',
      fromSessionKey: SOURCE,
      toSessionKey: TARGET,
      now: NOW,
    });

    expect(result.moved).toBe(false);
    expect(result.fromCount).toBe(2);
    expect(result.toCount).toBe(1);
  });

  it('refuses a target without a History row and changes nothing', async () => {
    await expect(
      moveProductToCollection({
        asin: 'B08N5WRWNW',
        fromSessionKey: SOURCE,
        toSessionKey: 'oc_missing',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(CollectionMoveError);

    const row = await db.products
      .where('[sessionKey+asin]')
      .equals([SOURCE, 'B08N5WRWNW'])
      .first();
    expect(row?.asin).toBe('B08N5WRWNW');
  });

  it('rolls the product back when a later step in the transaction fails', async () => {
    // The product update has already run when the snapshot update throws, so a
    // committed transaction would leave the row in the target with its
    // snapshots stranded in the source. A Dexie hook keeps the failure inside
    // the transaction zone (a mocked table method would escape it).
    const failing = () => {
      throw new Error('simulated snapshot failure');
    };
    db.snapshots.hook('updating', failing);

    try {
      await expect(async () =>
        moveProductToCollection({
          asin: 'B08N5WRWNW',
          fromSessionKey: SOURCE,
          toSessionKey: TARGET,
          now: NOW,
        }),
      ).rejects.toThrow('simulated snapshot failure');
    } finally {
      db.snapshots.hook('updating').unsubscribe(failing);
    }

    const row = await db.products
      .where('[sessionKey+asin]')
      .equals([SOURCE, 'B08N5WRWNW'])
      .first();
    expect(row).toBeTruthy();

    const source = await db.history.where('sessionKey').equals(SOURCE).first();
    expect(source?.collectedCount).toBe(0);
    expect(await db.snapshots.where('sessionKey').equals(TARGET).count()).toBe(0);
  });
});

describe('discardCollection', () => {
  it('removes a target created for a move that never happened', async () => {
    await db.history.add(historyRow('oc_abandoned', 'Abandoned'));

    await discardCollection('oc_abandoned');

    expect(
      await db.history.where('sessionKey').equals('oc_abandoned').first(),
    ).toBeUndefined();
    expect(
      await db.history.where('sessionKey').equals(SOURCE).first(),
    ).toBeTruthy();
    expect(await db.products.count()).toBe(3);
  });
});
