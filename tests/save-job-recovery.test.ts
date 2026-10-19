/**
 * SAD-289 (P4.4) - what happens to a save whose service worker died.
 *
 * The rule the whole module rests on: the product row is written *before*
 * enrichment, so recovery only ever re-runs the upgrade. It must never invent a
 * save that did not commit, never enrich the same job twice, and never leave the
 * card spinning: every branch ends in a terminal state with a message.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SAVE_JOB_STORE_KEY,
  SAVE_JOB_TTL_MS,
  createJobStore,
  type SaveJobRecord,
} from '@/engines/amazon/background/job-store';
import { recoverSaveJobs } from '@/engines/amazon/background/save-job-recovery';
import type { ProductSnapshot } from '@/engines/amazon/types';

const T0 = Date.parse('2026-10-19T09:00:00.000Z');

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

function snapshot(
  overrides: Partial<ProductSnapshot> = {},
): ProductSnapshot {
  return {
    asin: 'B08N5WRWNW',
    sessionKey: 'one-click-1',
    jobId: 'job-1',
    source: 'listing',
    capturedAt: new Date(T0).toISOString(),
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 1200,
    ...overrides,
  };
}

function job(overrides: Partial<SaveJobRecord> = {}): SaveJobRecord {
  return {
    jobId: 'job-1',
    asin: 'B08N5WRWNW',
    productUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
    tabId: 7,
    state: 'enriching',
    attempts: 0,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

/** A store that already holds `records`, as if the worker had just woken. */
function storeWith(records: SaveJobRecord[] | unknown, now = T0 + 60_000) {
  const area = sessionArea();
  area.map.set(SAVE_JOB_STORE_KEY, records);
  const store = createJobStore({
    sessionArea: area.api,
    now: () => now,
    debounceMs: 0,
  });
  return { store, area };
}

describe('recoverSaveJobs', () => {
  it('fails a job that never reached the database instead of replaying it', async () => {
    const { store } = storeWith([job()]);
    const enrich = vi.fn();
    const updates: Array<Record<string, unknown>> = [];

    const report = await recoverSaveJobs({
      store,
      enrich,
      emit: (update) => updates.push(update as unknown as Record<string, unknown>),
      findSnapshots: async () => [],
      now: () => new Date(T0 + 60_000),
    });

    expect(report.failed).toBe(1);
    expect(enrich).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      jobId: 'job-1',
      state: 'failed',
      errorCode: 'DB_WRITE_FAILED',
    });
    expect(store.get('job-1')?.state).toBe('failed');
  });

  it('re-runs enrichment once for a job whose listing row exists', async () => {
    const { store } = storeWith([job()]);
    const enrich = vi.fn(async () => ({ status: 'complete' as const }));
    const updates: Array<Record<string, unknown>> = [];

    const report = await recoverSaveJobs({
      store,
      enrich,
      emit: (update) => updates.push(update as unknown as Record<string, unknown>),
      findSnapshots: async () => [snapshot()],
      now: () => new Date(T0 + 60_000),
    });

    expect(report.resumed).toBe(1);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith({
      jobId: 'job-1',
      asin: 'B08N5WRWNW',
      productUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
      sessionKey: 'one-click-1',
    });
    expect(updates[0]).toMatchObject({
      state: 'completed',
      collectionKey: 'one-click-1',
      enrichmentStatus: 'complete',
    });
    expect(store.get('job-1')).toMatchObject({
      state: 'completed',
      attempts: 1,
      sessionKey: 'one-click-1',
    });
  });

  it('reports interrupted instead of looping when the re-run dies too', async () => {
    const { store } = storeWith([job({ attempts: 1 })]);
    const enrich = vi.fn();
    const updates: Array<Record<string, unknown>> = [];

    const report = await recoverSaveJobs({
      store,
      enrich,
      emit: (update) => updates.push(update as unknown as Record<string, unknown>),
      findSnapshots: async () => [snapshot()],
      now: () => new Date(T0 + 60_000),
    });

    expect(report.interrupted).toBe(1);
    expect(enrich).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      state: 'completed',
      enrichmentStatus: 'interrupted',
      warning: 'Saved, but details could not be refreshed',
    });
    expect(store.get('job-1')?.enrichmentStatus).toBe('interrupted');
  });

  it('completes without enriching when the detail snapshot already landed', async () => {
    const { store } = storeWith([job()]);
    const enrich = vi.fn();
    const updates: Array<Record<string, unknown>> = [];

    await recoverSaveJobs({
      store,
      enrich,
      emit: (update) => updates.push(update as unknown as Record<string, unknown>),
      findSnapshots: async () => [snapshot(), snapshot({ source: 'detail' })],
      now: () => new Date(T0 + 60_000),
    });

    expect(enrich).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      state: 'completed',
      collectionKey: 'one-click-1',
    });
  });

  it('leaves terminal jobs alone', async () => {
    const { store } = storeWith([
      job({ jobId: 'done', state: 'completed' }),
      job({ jobId: 'dead', state: 'failed' }),
    ]);
    const enrich = vi.fn();
    const emit = vi.fn();

    const report = await recoverSaveJobs({
      store,
      enrich,
      emit,
      findSnapshots: async () => [snapshot()],
      now: () => new Date(T0 + 60_000),
    });

    expect(enrich).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(report.resumed + report.interrupted + report.failed).toBe(0);
  });

  it('never resumes a row past the 15-minute TTL', async () => {
    const { store } = storeWith([job()], T0 + SAVE_JOB_TTL_MS + 1);
    const enrich = vi.fn();
    const emit = vi.fn();

    const report = await recoverSaveJobs({
      store,
      enrich,
      emit,
      findSnapshots: async () => [snapshot()],
      now: () => new Date(T0 + SAVE_JOB_TTL_MS + 1),
    });

    expect(report.dropped).toBe(1);
    expect(enrich).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('contains an enrichment that throws', async () => {
    const { store } = storeWith([job()]);
    const updates: Array<Record<string, unknown>> = [];

    await recoverSaveJobs({
      store,
      enrich: async () => {
        throw new Error('worker died again');
      },
      emit: (update) => updates.push(update as unknown as Record<string, unknown>),
      findSnapshots: async () => [snapshot()],
      now: () => new Date(T0 + 60_000),
    });

    expect(updates[0]).toMatchObject({ state: 'completed', enrichmentStatus: 'failed' });
    expect(store.get('job-1')?.state).toBe('completed');
  });

  it('is a no-op when the mirror is empty', async () => {
    const { store } = storeWith([]);
    const report = await recoverSaveJobs({
      store,
      enrich: vi.fn(),
      emit: vi.fn(),
      findSnapshots: async () => [],
      now: () => new Date(T0 + 60_000),
    });

    expect(report).toEqual({ resumed: 0, interrupted: 0, failed: 0, dropped: 0 });
  });
});
