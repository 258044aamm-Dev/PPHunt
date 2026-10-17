/**
 * Step 4.5 (SAD-176) — M-9: history deletion is scoped and atomic.
 * "Clear all history" no longer destroys an in-flight session's products,
 * deletes leave no orphans, and a failure mid-transaction rolls everything back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/database';
import { clearAllHistory, deleteHistory } from '@/lib/db/history';

function historyRow(sessionKey: string) {
  return {
    sessionKey,
    url: `https://www.amazon.com/s?k=${sessionKey}`,
    mode: 'manual' as const,
    targetCount: 50,
    collectedCount: 1,
    startedAt: '2026-10-16T08:00:00.000Z',
    completedAt: '2026-10-16T08:05:00.000Z',
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

function sessionRow(id: string, status: 'collecting' | 'completed') {
  return {
    id,
    tabId: 1,
    url: 'https://www.amazon.com/s?k=x',
    status,
    mode: 'manual' as const,
    targetCount: 50,
    collectedCount: 0,
    startedAt: '2026-10-16T08:00:00.000Z',
    updatedAt: '2026-10-16T08:05:00.000Z',
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M-9: clearAllHistory is scoped', () => {
  it("keeps an in-flight session's products; removes history + matching session rows", async () => {
    await db.history.bulkPut([historyRow('s_done_1'), historyRow('s_done_2')]);
    await db.products.bulkPut([
      product('B0DONE1', 's_done_1'),
      product('B0DONE2', 's_done_2'),
      product('B0LIVE1', 's_live'), // in-flight: NO history row
      product('B0LIVE2', 's_live'),
    ]);
    await db.sessions.bulkPut([
      sessionRow('s_done_1', 'completed'),
      sessionRow('s_done_2', 'completed'),
      sessionRow('s_live', 'collecting'),
    ]);

    await clearAllHistory();

    expect(await db.history.count()).toBe(0);
    const asins = (await db.products.toArray()).map((p) => p.asin).sort();
    // fails before Step 4.5: db.products.clear() destroyed B0LIVE* too
    expect(asins).toEqual(['B0LIVE1', 'B0LIVE2']);
    expect(await db.sessions.get('s_done_1')).toBeUndefined(); // no orphans
    expect(await db.sessions.get('s_done_2')).toBeUndefined();
    expect(await db.sessions.get('s_live')).toBeTruthy(); // untouched
  });
});

describe('M-9: deletes are atomic', () => {
  it('a failure mid-transaction rolls back everything', async () => {
    await db.history.put(historyRow('s_atomic'));
    await db.products.put(product('B0ATOM', 's_atomic'));
    await db.sessions.put(sessionRow('s_atomic', 'completed'));

    // explode part-way through the transaction
    vi.spyOn(db.sessions, 'delete').mockRejectedValueOnce(
      new Error('simulated crash')
    );

    await expect(clearAllHistory()).rejects.toThrow('simulated crash');

    // nothing was deleted — the history.clear() inside the tx rolled back too
    expect(await db.history.count()).toBe(1);
    expect(await db.products.count()).toBe(1);
    expect(await db.sessions.count()).toBe(1);
  });
});

describe('M-9: deleteHistory is scoped and complete', () => {
  it('removes the history row, its products and its session row; others untouched', async () => {
    const id = (await db.history.add(historyRow('s_one'))) as number;
    await db.history.put(historyRow('s_two'));
    await db.products.bulkPut([
      product('B0ONE', 's_one'),
      product('B0TWO', 's_two'),
    ]);
    await db.sessions.bulkPut([
      sessionRow('s_one', 'completed'),
      sessionRow('s_two', 'completed'),
    ]);

    await deleteHistory(id);

    expect(await db.history.count()).toBe(1);
    const asins = (await db.products.toArray()).map((p) => p.asin);
    expect(asins).toEqual(['B0TWO']);
    expect(await db.sessions.get('s_one')).toBeUndefined(); // new in 4.5
    expect(await db.sessions.get('s_two')).toBeTruthy();
  });
});
