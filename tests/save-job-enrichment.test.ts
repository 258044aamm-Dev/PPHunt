/**
 * SAD-296 (P4.3) - the seam between "saved" and "enriched".
 *
 * The contract that matters: the row is committed before enrichment starts, so
 * a failed or slow enrichment never turns a successful save into a failure, and
 * a caller that does not pass the `enrich` dependency keeps the exact
 * pre-enrichment behaviour (this is what protects every SAD-281 test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import { updateSettings } from '@/engines/amazon/db/settings';
import {
  handleSaveProduct,
  resetSaveJobsForTests,
  type SaveJobUpdate,
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
        get: vi.fn(async (key: string) => (map.has(key) ? { [key]: map.get(key) } : {})),
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
    context: { pageType: 'search' as const, pageUrl: PAGE_URL, triggeredBy: 'card-button' as const },
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetSaveJobsForTests();
  storageStub();
});

describe('with an enrichment step', () => {
  it('reports extracting, enriching, then completed with the status', async () => {
    const states: string[] = [];
    const enrich = vi.fn(async () => ({ status: 'complete' as const }));

    const result = await handleSaveProduct(payload(), {
      emit: (update: SaveJobUpdate) => states.push(update.state),
      enrich,
    });

    expect(states).toEqual(['extracting', 'enriching', 'completed']);
    expect(result.state).toBe('completed');
    expect(result.enrichmentStatus).toBe('complete');
    expect(enrich).toHaveBeenCalledWith({
      jobId: 'job-1',
      asin: 'B08N5WRWNW',
      productUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
      sessionKey: result.collectionKey,
    });
  });

  it('enriches only after the row exists', async () => {
    let productsAtEnrich = -1;

    await handleSaveProduct(payload(), {
      enrich: async () => {
        productsAtEnrich = await db.products.count();
        return { status: 'partial' as const };
      },
    });

    expect(productsAtEnrich).toBe(1);
  });

  it('a throwing enrichment completes the job as failed enrichment, never a failed save', async () => {
    const result = await handleSaveProduct(payload(), {
      enrich: async () => {
        throw new Error('boom');
      },
    });

    expect(result.state).toBe('completed');
    expect(result.enrichmentStatus).toBe('failed');
    expect(await db.products.count()).toBe(1);
  });

  it('keeps a partial status as partial', async () => {
    const result = await handleSaveProduct(payload(), {
      enrich: async () => ({ status: 'partial' as const }),
    });

    expect(result.enrichmentStatus).toBe('partial');
  });

  it('does not ask for a collection choice on the enriching update', async () => {
    await updateSettings({ quickSaveCollectionBehavior: 'ask' });
    const updates: SaveJobUpdate[] = [];

    const result = await handleSaveProduct(payload('job-ask'), {
      emit: (update) => updates.push(update),
      enrich: async () => ({ status: 'complete' as const }),
    });

    const enriching = updates.find((update) => update.state === 'enriching');
    expect(enriching?.requiresCollectionChoice).toBeUndefined();

    expect(result.state).toBe('completed');
    expect(result.requiresCollectionChoice).toBe(true);
    expect(result.enrichmentStatus).toBe('complete');
  });
});

describe('without an enrichment step', () => {
  it('emits exactly the pre-enrichment states', async () => {
    const states: string[] = [];

    const result = await handleSaveProduct(payload(), {
      emit: (update) => states.push(update.state),
    });

    expect(states).toEqual(['extracting', 'completed']);
    expect(result.enrichmentStatus).toBeUndefined();
  });
});
