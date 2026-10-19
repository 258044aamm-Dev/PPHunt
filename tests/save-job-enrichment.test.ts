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
  enrichmentWarningFor,
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
    // SAD-335: a thrown enrichment is still a completed save, but it must say so.
    expect(result.warning).toBeTruthy();
    expect(await db.products.count()).toBe(1);
  });

  it('keeps a partial status as partial and warns', async () => {
    const result = await handleSaveProduct(payload(), {
      enrich: async () => ({ status: 'partial' as const }),
    });

    expect(result.enrichmentStatus).toBe('partial');
    expect(result.warning).toBeTruthy();
    expect(result.state).toBe('completed');
  });

  it('carries the enrichment error code on a completed save', async () => {
    const result = await handleSaveProduct(payload(), {
      enrich: async () => ({
        status: 'failed' as const,
        errorCode: 'ENRICH_FETCH_FAILED' as const,
      }),
    });

    expect(result.state).toBe('completed');
    expect(result.enrichmentStatus).toBe('failed');
    expect(result.errorCode).toBe('ENRICH_FETCH_FAILED');
    // SAD-335: a failed fetch is reported, not hidden behind a clean "Saved to …".
    expect(result.warning).toBe(
      'Saved, but the product details could not be fetched — details may be incomplete',
    );
  });

  it('names the parse failure when the page could not be read', async () => {
    const result = await handleSaveProduct(payload(), {
      enrich: async () => ({
        status: 'failed' as const,
        errorCode: 'ENRICH_PARSE_FAILED' as const,
      }),
    });

    expect(result.state).toBe('completed');
    expect(result.warning).toBe(
      'Saved, but the product page could not be read — details may be incomplete',
    );
  });

  it('warns when enrichment is skipped', async () => {
    const result = await handleSaveProduct(payload(), {
      enrich: async () => ({ status: 'skipped' as const }),
    });

    expect(result.enrichmentStatus).toBe('skipped');
    // SAD-335: "the guard fired, nothing was attempted" still means the row is
    // missing product-page fields, so the user must be told.
    expect(result.warning).toBe(
      'Saved, but the product page was not fetched — details may be incomplete',
    );
  });

  it('stays silent when enrichment is complete', async () => {
    const result = await handleSaveProduct(payload(), {
      enrich: async () => ({ status: 'complete' as const }),
    });

    expect(result.enrichmentStatus).toBe('complete');
    expect(result.warning).toBeUndefined();
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

describe('enrichmentWarningFor', () => {
  it('maps every non-complete status to an operator-readable warning', () => {
    expect(enrichmentWarningFor('complete')).toBeUndefined();
    expect(enrichmentWarningFor(undefined)).toBeUndefined();
    expect(enrichmentWarningFor('partial')).toBe(
      'Saved, but the product page had no complete details',
    );
    expect(enrichmentWarningFor('skipped')).toBe(
      'Saved, but the product page was not fetched — details may be incomplete',
    );
    expect(enrichmentWarningFor('interrupted')).toBe(
      'Saved, but the product details were interrupted — details may be incomplete',
    );
    expect(enrichmentWarningFor('failed', 'ENRICH_PARSE_FAILED')).toBe(
      'Saved, but the product page could not be read — details may be incomplete',
    );
    expect(enrichmentWarningFor('failed')).toBe(
      'Saved, but the product details could not be fetched — details may be incomplete',
    );
  });
});

describe('SAD-337: a save made on the product page needs no enrichment', () => {
  const PDP_URL = 'https://www.amazon.com/dp/B08N5WRWNW';

  function pdpPayload(jobId = 'job-pdp') {
    return {
      jobId,
      product: product(),
      context: {
        pageType: 'product-detail' as const,
        pageUrl: PDP_URL,
        triggeredBy: 'context-menu' as const,
      },
    };
  }

  it('never calls enrich and never emits the enriching transition', async () => {
    const states: string[] = [];
    const enrich = vi.fn(async () => ({ status: 'partial' as const }));

    const result = await handleSaveProduct(pdpPayload(), {
      emit: (update: SaveJobUpdate) => states.push(update.state),
      enrich,
    });

    expect(enrich).not.toHaveBeenCalled();
    expect(states).toEqual(['extracting', 'completed']);
    expect(result.state).toBe('completed');
    expect(result.enrichmentStatus).toBe('complete');
    // Nothing was fetched, so there is nothing to warn about.
    expect(result.warning).toBeUndefined();
  });

  it('keeps the row and exactly one detail snapshot', async () => {
    await handleSaveProduct(pdpPayload('job-pdp-snap'), {
      enrich: vi.fn(async () => ({ status: 'complete' as const })),
    });

    const products = await db.products.toArray();
    expect(products).toHaveLength(1);
    expect(products[0]?.title).toBe('Anker 65W Charger');

    const snapshots = await db.snapshots.toArray();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.source).toBe('detail');
    expect(snapshots[0]?.jobId).toBe('job-pdp-snap');
  });

  it('is reported complete even when the caller passes no enrich dependency', async () => {
    const result = await handleSaveProduct(pdpPayload('job-pdp-no-dep'));

    expect(result.state).toBe('completed');
    expect(result.enrichmentStatus).toBe('complete');
    expect(result.warning).toBeUndefined();
  });

  it('still enriches a listing save exactly once', async () => {
    const enrich = vi.fn(async () => ({ status: 'complete' as const }));

    const result = await handleSaveProduct(payload('job-listing'), { enrich });

    expect(enrich).toHaveBeenCalledTimes(1);
    expect(result.enrichmentStatus).toBe('complete');
    const snapshots = await db.snapshots.toArray();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.source).toBe('listing');
  });
});
