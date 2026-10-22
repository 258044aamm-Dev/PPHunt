/**
 * SAD-275 (P0.2) - the `snapshots` store is additive, and every delete path
 * cleans it up.
 *
 * Two properties matter and neither is visible in the UI:
 *   1. upgrading a real v1 database keeps every product/history/session row;
 *   2. deleting a collection never leaves orphan snapshot rows behind.
 */
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PPHuntDB } from '@/engines/amazon/db/database';
import { db } from '@/lib/db/database';
import { clearAllHistory, deleteHistory } from '@/lib/db/history';
import { pruneOldSessions } from '@/lib/db/sessions';
import { deleteSession } from '@/engines/amazon/db/sessions';

const LEGACY_NAME = 'PPHuntLegacyMigrationTest';

function historyRow(sessionKey: string, startedAt = '2026-10-16T08:00:00.000Z') {
  return {
    sessionKey,
    url: `https://www.amazon.com/s?k=${sessionKey}`,
    mode: 'manual' as const,
    targetCount: 50,
    collectedCount: 1,
    startedAt,
    completedAt: startedAt,
    status: 'completed' as const,
  };
}

function product(asin: string, sessionKey: string) {
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    collectedAt: '2026-10-16T08:01:00.000Z',
    sessionKey,
    source: 'search' as const,
  };
}

function snapshot(asin: string, sessionKey: string, capturedAt: string, jobId = 'job-1') {
  return {
    asin,
    sessionKey,
    jobId,
    source: 'listing' as const,
    capturedAt,
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 120,
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  await Dexie.delete(LEGACY_NAME);
});

describe('Dexie v2 snapshots store', () => {
  it('upgrades a v1 database in place without losing rows', async () => {
    const legacy = new Dexie(LEGACY_NAME);
    legacy.version(1).stores({
      products: '++id, asin, sessionKey, collectedAt, [sessionKey+asin]',
      sessions: 'id, tabId, status, startedAt, updatedAt',
      history: '++id, sessionKey, startedAt, completedAt, status',
      settings: 'id',
    });
    await legacy.open();
    await legacy.table('products').add(product('B08N5WRWNW', 'session-legacy'));
    await legacy.table('history').add(historyRow('session-legacy'));
    await legacy.table('sessions').add({
      id: 'session-legacy',
      tabId: 7,
      url: 'https://www.amazon.com/s?k=legacy',
      status: 'completed',
      mode: 'manual',
      targetCount: 50,
      collectedCount: 1,
      startedAt: '2026-10-16T08:00:00.000Z',
      updatedAt: '2026-10-16T08:05:00.000Z',
    });
    legacy.close();

    const upgraded = new PPHuntDB(LEGACY_NAME);
    await upgraded.open();

    // SAD-392: the latest schema is v3 (data-only availability cleanup); this
    // v1 database must land on it with every row preserved — the property
    // this test has always pinned. The legacy product row carries no
    // `availability` key, so the v3 pass leaves it untouched.
    expect(upgraded.verno).toBe(3);
    expect(await upgraded.products.count()).toBe(1);
    expect(await upgraded.history.count()).toBe(1);
    expect(await upgraded.sessions.count()).toBe(1);
    expect(upgraded.tables.map((table) => table.name)).toContain('snapshots');

    // The new store is writable straight after the upgrade.
    await upgraded.snapshots.add(
      snapshot('B08N5WRWNW', 'session-legacy', '2026-10-16T08:02:00.000Z')
    );
    expect(await upgraded.snapshots.count()).toBe(1);

    upgraded.close();
  });

  it('writes and reads snapshots through the (asin, capturedAt) compound index', async () => {
    await db.snapshots.bulkAdd([
      snapshot('B08N5WRWNW', 's1', '2026-10-16T08:00:00.000Z'),
      snapshot('B08N5WRWNW', 's1', '2026-10-17T08:00:00.000Z'),
      snapshot('B0OTHERAAA', 's1', '2026-10-16T08:00:00.000Z'),
    ] as never);

    const rows = await db.snapshots
      .where('[asin+capturedAt]')
      .between(['B08N5WRWNW', Dexie.minKey], ['B08N5WRWNW', Dexie.maxKey])
      .toArray();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.capturedAt)).toEqual([
      '2026-10-16T08:00:00.000Z',
      '2026-10-17T08:00:00.000Z',
    ]);
  });

  it('deleteHistory removes the history row, its products and its snapshots', async () => {
    const historyId = await db.history.add(historyRow('oc_1'));
    await db.products.add(product('B08N5WRWNW', 'oc_1'));
    await db.snapshots.add(snapshot('B08N5WRWNW', 'oc_1', '2026-10-16T08:01:00.000Z'));
    await db.snapshots.add(snapshot('B08N5WRWNW', 'oc_1', '2026-10-16T08:02:00.000Z', 'job-2'));

    await deleteHistory(historyId);

    expect(await db.history.count()).toBe(0);
    expect(await db.products.count()).toBe(0);
    expect(await db.snapshots.count()).toBe(0);
  });

  it('deleteHistory tolerates a one-click collection with no sessions row', async () => {
    // One-click collections are history + products + snapshots only (plan 6.6).
    const historyId = await db.history.add(historyRow('oc_2'));
    await db.products.add(product('B08N5WRWNW', 'oc_2'));
    await db.snapshots.add(snapshot('B08N5WRWNW', 'oc_2', '2026-10-16T08:01:00.000Z'));

    await expect(deleteHistory(historyId)).resolves.toBeUndefined();
    expect(await db.snapshots.count()).toBe(0);
  });

  it('clearAllHistory removes snapshots but keeps an in-flight session intact', async () => {
    await db.history.add(historyRow('done-1'));
    await db.products.add(product('B08N5WRWNW', 'done-1'));
    await db.snapshots.add(snapshot('B08N5WRWNW', 'done-1', '2026-10-16T08:01:00.000Z'));

    await db.sessions.add({
      id: 'live-1',
      tabId: 3,
      url: 'https://www.amazon.com/s?k=live',
      status: 'collecting',
      mode: 'manual',
      targetCount: 50,
      collectedCount: 1,
      startedAt: '2026-10-16T09:00:00.000Z',
      updatedAt: '2026-10-16T09:01:00.000Z',
    });
    await db.products.add(product('B0LIVEAAAA', 'live-1'));
    await db.snapshots.add(snapshot('B0LIVEAAAA', 'live-1', '2026-10-16T09:01:00.000Z'));

    await clearAllHistory();

    expect(await db.history.count()).toBe(0);
    expect(await db.products.count()).toBe(1);
    expect(await db.snapshots.count()).toBe(1);
    const remaining = await db.snapshots.toArray();
    expect(remaining[0]?.sessionKey).toBe('live-1');
  });

  it('deleteSession removes the session products and snapshots', async () => {
    await db.sessions.add({
      id: 's-del',
      tabId: 4,
      url: 'https://www.amazon.com/s?k=del',
      status: 'completed',
      mode: 'manual',
      targetCount: 10,
      collectedCount: 1,
      startedAt: '2026-10-16T08:00:00.000Z',
      updatedAt: '2026-10-16T08:05:00.000Z',
    });
    await db.products.add(product('B08N5WRWNW', 's-del'));
    await db.snapshots.add(snapshot('B08N5WRWNW', 's-del', '2026-10-16T08:01:00.000Z'));

    await deleteSession('s-del');

    expect(await db.products.count()).toBe(0);
    expect(await db.snapshots.count()).toBe(0);
  });

  it('pruneOldSessions drops stale snapshots and keeps recent ones', async () => {
    const old = '2026-01-01T00:00:00.000Z';
    const fresh = new Date().toISOString();

    await db.sessions.add({
      id: 'stale',
      tabId: 5,
      url: 'https://www.amazon.com/s?k=stale',
      status: 'completed',
      mode: 'manual',
      targetCount: 10,
      collectedCount: 1,
      startedAt: old,
      updatedAt: old,
    });
    await db.products.add(product('B08N5WRWNW', 'stale'));
    await db.snapshots.add(snapshot('B08N5WRWNW', 'stale', old));

    await db.sessions.add({
      id: 'fresh',
      tabId: 6,
      url: 'https://www.amazon.com/s?k=fresh',
      status: 'completed',
      mode: 'manual',
      targetCount: 10,
      collectedCount: 1,
      startedAt: fresh,
      updatedAt: fresh,
    });
    await db.products.add(product('B0FRESHAAA', 'fresh'));
    await db.snapshots.add(snapshot('B0FRESHAAA', 'fresh', fresh));

    const pruned = await pruneOldSessions(30 * 24 * 60 * 60 * 1000);

    expect(pruned).toBe(1);
    const remaining = await db.snapshots.toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sessionKey).toBe('fresh');
  });
});
