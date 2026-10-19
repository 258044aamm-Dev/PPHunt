/**
 * SAD-289 (P4.4) - the job table behind MV3 worker recovery.
 *
 * The store itself has one job: whatever a service worker remembers about an
 * in-flight save must survive the worker being suspended. That means the mirror
 * in `storage.session` is the source of truth across a wake, the 15-minute TTL
 * is enforced on read *and* on every sweep, and a corrupt mirror degrades to
 * "nothing to resume" rather than throwing inside a save.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SAVE_JOB_STORE_KEY,
  SAVE_JOB_TTL_MS,
  createJobStore,
  type SaveJobRecord,
} from '@/engines/amazon/background/job-store';

function sessionArea() {
  const map = new Map<string, unknown>();
  return {
    map,
    api: {
      get: vi.fn(async (key: string) =>
        map.has(key) ? { [key]: map.get(key) } : {},
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) map.set(key, value);
      }),
    },
  };
}

const T0 = Date.parse('2026-10-19T09:00:00.000Z');

function base(overrides: Partial<SaveJobRecord> = {}): SaveJobRecord {
  return {
    jobId: 'job-1',
    asin: 'B08N5WRWNW',
    productUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
    state: 'enriching',
    attempts: 0,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

function makeStore(options: {
  area?: ReturnType<typeof sessionArea>['api'] | null;
  now?: () => number;
} = {}) {
  return createJobStore({
    sessionArea: options.area === undefined ? null : options.area,
    now: options.now ?? (() => T0),
    debounceMs: 0,
  });
}

describe('job store: in-memory table', () => {
  it('starts a job in queued with the identity it needs to resume', () => {
    const store = makeStore();
    const record = store.begin({
      jobId: 'job-1',
      asin: 'B08N5WRWNW',
      productUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
      tabId: 12,
      sessionKey: 'one-click-1',
    });

    expect(record.state).toBe('queued');
    expect(record.attempts).toBe(0);
    expect(record.tabId).toBe(12);
    expect(store.get('job-1')).toEqual(record);
  });

  it('moves a job forward and stamps updatedAt', () => {
    let clock = T0;
    const store = makeStore({ now: () => clock });
    store.begin({ jobId: 'job-1', asin: 'B08N5WRWNW', productUrl: 'u' });

    clock = T0 + 5_000;
    const updated = store.update('job-1', { state: 'extracting' });

    expect(updated?.state).toBe('extracting');
    expect(updated?.updatedAt).toBe(new Date(T0 + 5_000).toISOString());
  });

  it('ignores an update for a job it never started', () => {
    const store = makeStore();
    expect(store.update('ghost', { state: 'completed' })).toBeUndefined();
  });
});

describe('job store: storage.session mirror', () => {
  it('mirrors the table under one key', async () => {
    const area = sessionArea();
    const store = makeStore({ area: area.api });
    store.begin({ jobId: 'job-1', asin: 'B08N5WRWNW', productUrl: 'u' });

    await store.flush();

    const mirrored = area.map.get(SAVE_JOB_STORE_KEY) as SaveJobRecord[];
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({ jobId: 'job-1', state: 'queued' });
  });

  it('survives a restart: a second store hydrates the first one\'s jobs', async () => {
    const area = sessionArea();
    const first = makeStore({ area: area.api });
    first.begin({
      jobId: 'job-1',
      asin: 'B08N5WRWNW',
      productUrl: 'u',
      sessionKey: 'one-click-1',
    });
    first.update('job-1', { state: 'enriching' });
    await first.flush();

    const second = makeStore({ area: area.api, now: () => T0 + 60_000 });
    const { kept, dropped } = await second.hydrate();

    expect(dropped).toBe(0);
    expect(kept).toHaveLength(1);
    expect(second.get('job-1')?.state).toBe('enriching');
    expect(second.get('job-1')?.sessionKey).toBe('one-click-1');
  });

  it('drops a job older than the 15-minute TTL on hydrate', async () => {
    const area = sessionArea();
    const first = makeStore({ area: area.api });
    first.begin({ jobId: 'job-1', asin: 'B08N5WRWNW', productUrl: 'u' });
    await first.flush();

    const later = makeStore({
      area: area.api,
      now: () => T0 + SAVE_JOB_TTL_MS + 1,
    });
    const { kept, dropped } = await later.hydrate();

    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
    expect(later.get('job-1')).toBeUndefined();
  });

  it('keeps a the live row when the mirror holds an older copy', async () => {
    const area = sessionArea();
    const store = makeStore({ area: area.api });
    store.begin({ jobId: 'job-1', asin: 'B08N5WRWNW', productUrl: 'u' });
    store.update('job-1', { state: 'enriching' });

    // A previous write is still in the mirror.
    area.map.set(SAVE_JOB_STORE_KEY, [base({ state: 'queued' })]);

    await store.hydrate();
    expect(store.get('job-1')?.state).toBe('enriching');
  });

  it('ignores rows that are not job records', async () => {
    const area = sessionArea();
    area.map.set(SAVE_JOB_STORE_KEY, [
      null,
      { jobId: 'job-1' },
      { ...base(), state: 7 },
      base(),
    ]);

    const store = makeStore({ area: area.api });
    const { kept, dropped } = await store.hydrate();

    expect(kept).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  it('treats a missing or unreadable mirror as nothing to resume', async () => {
    const store = makeStore({
      area: {
        get: vi.fn().mockRejectedValue(new Error('no session storage')),
        set: vi.fn().mockResolvedValue(undefined),
      },
    });

    await expect(store.hydrate()).resolves.toEqual({ kept: [], dropped: 0 });
  });

  it('defaults attempts to 0 for a row written before the field existed', async () => {
    const area = sessionArea();
    const legacy = base();
    delete (legacy as Partial<SaveJobRecord>).attempts;
    area.map.set(SAVE_JOB_STORE_KEY, [legacy]);

    const store = makeStore({ area: area.api });
    await store.hydrate();

    expect(store.get('job-1')?.attempts).toBe(0);
  });

  it('flushes a terminal state immediately', async () => {
    const area = sessionArea();
    const store = makeStore({ area: area.api });
    store.begin({ jobId: 'job-1', asin: 'B08N5WRWNW', productUrl: 'u' });
    area.api.set.mockClear();

    store.update('job-1', { state: 'completed' });

    await vi.waitFor(() => expect(area.api.set).toHaveBeenCalled());
    const mirrored = area.map.get(SAVE_JOB_STORE_KEY) as SaveJobRecord[];
    expect(mirrored[0]?.state).toBe('completed');
  });

  it('sweeps expired jobs out of the table and the mirror', async () => {
    let clock = T0;
    const area = sessionArea();
    const store = makeStore({ area: area.api, now: () => clock });
    store.begin({ jobId: 'job-1', asin: 'A1', productUrl: 'u' });
    await store.flush();

    clock = T0 + SAVE_JOB_TTL_MS + 1;
    expect(store.sweep()).toBe(1);
    await store.flush();

    expect(store.all()).toHaveLength(0);
    expect(area.map.get(SAVE_JOB_STORE_KEY)).toEqual([]);
  });

  it('evicts a timed-out job when another one finishes', async () => {
    let clock = T0;
    const store = makeStore({ now: () => clock });
    store.begin({ jobId: 'stale', asin: 'A1', productUrl: 'u' });

    // Two minutes later a second job runs and completes; the first one has been
    // sitting in a resumable state far past the TTL.
    clock = T0 + 16 * 60 * 1000;
    store.begin({ jobId: 'fresh', asin: 'A2', productUrl: 'u' });
    store.update('fresh', { state: 'completed' });

    expect(store.get('stale')).toBeUndefined();
    expect(store.get('fresh')?.state).toBe('completed');
  });

  it('works with no storage.session at all', async () => {
    const store = makeStore({ area: null });
    store.begin({ jobId: 'job-1', asin: 'A1', productUrl: 'u' });

    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.get('job-1')?.state).toBe('queued');
  });
});
