/**
 * SAD-289 (P4.4) - the save pipeline and the job table must not drift.
 *
 * `handleSaveProduct` reports through one helper, and that helper mirrors the
 * transition into the store. These tests pin that seam: the store ends in the
 * same terminal state the UI was told about, and a caller that passes no store
 * keeps the pre-SAD-289 behaviour exactly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import { createJobStore } from '@/engines/amazon/background/job-store';
import {
  handleSaveProduct,
  resetSaveJobsForTests,
} from '@/engines/amazon/background/save-job';
import type { ScrapedProduct } from '@/engines/amazon/types';

const PAGE_URL = 'https://www.amazon.com/s?k=charger';

function product(): ScrapedProduct {
  return {
    asin: 'B08N5WRWNW',
    url: 'https://www.amazon.com/dp/B08N5WRWNW',
    title: 'Anker 65W Charger',
    price: 19.99,
    currency: 'USD',
    source: 'search',
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
}

function payload(jobId = 'job-1') {
  return {
    jobId,
    product: product(),
    context: {
      pageType: 'search' as const,
      pageUrl: PAGE_URL,
      triggeredBy: 'card-button' as const,
    },
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetSaveJobsForTests();
  storageStub();
});

describe('handleSaveProduct -> job store', () => {
  it('walks the stored job from queued to completed with the collection key', async () => {
    const store = createJobStore({ sessionArea: null });
    const seen: string[] = [];

    await handleSaveProduct(payload(), {
      store,
      enrich: async () => ({ status: 'complete' as const }),
      emit: (update) => seen.push(update.state),
    });

    const record = store.get('job-1');
    expect(record?.state).toBe('completed');
    expect(record?.enrichmentStatus).toBe('complete');
    expect(record?.sessionKey).toMatch(/^oc_/);
    expect(seen).toEqual(['extracting', 'enriching', 'completed']);
  });

  it('records the failure state when the save cannot be written', async () => {
    const store = createJobStore({ sessionArea: null });

    const update = await handleSaveProduct(
      { ...payload(), product: { ...product(), asin: 'not an asin' } },
      { store },
    );

    expect(update.state).toBe('failed');
    expect(store.get('job-1')?.state).toBe('failed');
  });

  it('keeps the job resumable while the row is being enriched', async () => {
    const store = createJobStore({ sessionArea: null });
    let duringEnrich: string | undefined;

    await handleSaveProduct(payload(), {
      store,
      enrich: async () => {
        duringEnrich = store.get('job-1')?.state;
        return { status: 'partial' as const };
      },
    });

    expect(duringEnrich).toBe('enriching');
    expect(store.get('job-1')?.enrichmentStatus).toBe('partial');
  });

  it('does not require a store at all', async () => {
    const update = await handleSaveProduct(payload());
    expect(update.state).toBe('completed');
  });
});
