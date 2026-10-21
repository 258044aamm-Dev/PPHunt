import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const { enrich } = vi.hoisted(() => ({ enrich: vi.fn() }));
vi.mock('@/engines/amazon/background/enrich-saved-product', () => ({ enrichSavedProduct: enrich }));
import {
  COLLECTION_ENRICHMENT_KEY as KEY,
  COLLECTION_ENRICHMENT_ALARM as ALARM,
  recoverCollectionEnrichment,
  scheduleCollectionEnrichment,
  whenCollectionEnrichmentIdle,
  resetCollectionEnrichmentForTests,
  collectionEnrichmentQueuedCount,
} from '@/engines/amazon/background/enrichment-pump';

let storage: Record<string, unknown>;
const ok = () => ({ status: 'complete', fieldsChanged: ['brand'], snapshotCreated: true, currencyMismatch: false });
const product = (n: number) => ({ asin: `B${String(n).padStart(9, '0')}`, url: `https://www.amazon.com/dp/B${String(n).padStart(9, '0')}` });
const alarm = vi.fn();
beforeEach(() => {
  resetCollectionEnrichmentForTests();
  storage = {};
  enrich.mockReset().mockResolvedValue(ok());
  alarm.mockReset();
  vi.stubGlobal('browser', {
    storage: { session: {
      get: vi.fn(async () => structuredClone(storage)),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(storage, structuredClone(items)); }),
    } },
    alarms: { create: alarm },
  });
});
afterEach(() => { resetCollectionEnrichmentForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('SAD-384 collection recovery', () => {
  it('persists the in-flight request and pending tail before fetching, and resumes them with the same scope/budget', async () => {
    enrich.mockImplementationOnce(() => new Promise(() => {}));
    await scheduleCollectionEnrichment([product(1), product(2), product(3)], 'run', { limit: 1, requiredFields: true });
    await waitFor(() => expect(enrich).toHaveBeenCalledTimes(1));
    const records = storage[KEY] as Array<{ state: string }>;
    expect(records.map(job => job.state)).toEqual(['in-flight', 'queued', 'queued']);
    resetCollectionEnrichmentForTests(); // simulate worker globals being discarded
    enrich.mockClear().mockResolvedValue(ok());
    await recoverCollectionEnrichment();
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(3);
    expect(enrich.mock.calls.map(([input]) => input.scope)).toEqual([undefined, 'brand-and-rank', 'brand-and-rank']);
    expect(collectionEnrichmentQueuedCount('run')).toBe(1);
    await scheduleCollectionEnrichment([product(1), product(4)], 'run', { limit: 1, requiredFields: true });
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(4);
    expect(enrich.mock.calls[3]?.[0].scope).toBe('brand-and-rank');
  });

  it('does not duplicate terminal records on boot or a trailing batch', async () => {
    await scheduleCollectionEnrichment([product(1)], 'run', { limit: 0, requiredFields: true });
    await whenCollectionEnrichmentIdle();
    resetCollectionEnrichmentForTests();
    await recoverCollectionEnrichment();
    await scheduleCollectionEnrichment([product(1)], 'run', { limit: 50, requiredFields: true });
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('defers a cooling host, continues another host and retries on the named wakeup', async () => {
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    enrich.mockResolvedValueOnce({ ...ok(), status: 'skipped', skipReason: 'circuit-open' });
    await scheduleCollectionEnrichment([product(1), product(2), { ...product(3), url: 'https://www.amazon.co.uk/dp/B000000003' }], 'run', { limit: 0, requiredFields: true });
    await whenCollectionEnrichmentIdle();
    expect(enrich.mock.calls.map(([input]) => input.asin)).toEqual(['B000000001', 'B000000003']);
    expect(alarm).toHaveBeenCalledWith(ALARM, { when: Date.now() + 60_000 });
    vi.setSystemTime(new Date(Date.now() + 60_001));
    await recoverCollectionEnrichment();
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(4);
    expect((storage[KEY] as Array<{ state: string }>).every(job => job.state === 'done')).toBe(true);
  });

  it('ignores malformed recovery data and bounds interrupted retry attempts', async () => {
    storage[KEY] = [{ invalid: true }, { ...product(1), productUrl: product(1).url, sessionKey: 'run', scope: 'brand-and-rank', state: 'in-flight', attempts: 2, createdAt: Date.now(), notBefore: 0 }];
    await recoverCollectionEnrichment();
    await whenCollectionEnrichmentIdle();
    expect(enrich).not.toHaveBeenCalled();
  });

  it('contains storage failures and still attempts already saved rows', async () => {
    vi.stubGlobal('browser', { storage: { session: {
      get: async () => { throw new Error('unavailable'); },
      set: async () => { throw new Error('quota'); },
    } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scheduleCollectionEnrichment([product(1)], 'run', { limit: 0, requiredFields: true });
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
