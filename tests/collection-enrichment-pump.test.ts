/**
 * SAD-379 step 1 — the collection enrichment pump.
 *
 * What is proven here, in the ticket's own terms:
 * - a product is queued **once per run**, even when a later `updatedExisting`
 *   batch re-sends the whole run;
 * - the per-run cap from the setting is honoured for `'25'`, `'50'` and `'all'`;
 * - the pump calls **the same function the save path uses**, with a job id that
 *   makes the snapshot write idempotent;
 * - a `skipped` outcome (breaker open / no permission) drains the queue instead
 *   of hammering Amazon;
 * - a throwing enrichment is never a collection error;
 * - `reset()` isolates one run from the next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectionEnrichmentJobId,
  collectionEnrichmentQueuedCount,
  enqueueCollectionEnrichment,
  resetCollectionEnrichment,
  resetCollectionEnrichmentForTests,
  whenCollectionEnrichmentIdle,
} from '@/engines/amazon/background/enrichment-pump';
import type { EnrichSavedProductResult } from '@/engines/amazon/background/enrich-saved-product';

const SESSION = 'session-a';

function product(asin: string) {
  return { asin, url: `https://www.amazon.com/dp/${asin}` };
}

function ok(): EnrichSavedProductResult {
  return {
    status: 'complete',
    fieldsChanged: ['rating'],
    snapshotCreated: true,
    currencyMismatch: false,
  };
}

/** A spy that records the exact input the pump hands to the save pipeline. */
interface EnrichInput {
  jobId: string;
  asin: string;
  productUrl: string;
  sessionKey: string;
}

function enrichSpy(
  result: () => EnrichSavedProductResult | Promise<EnrichSavedProductResult> = ok,
) {
  return vi.fn(async (_input: EnrichInput) => result());
}

beforeEach(() => {
  resetCollectionEnrichmentForTests();
});

describe('SAD-379: enrichment pump — one attempt per product per run', () => {
  it('calls the save pipeline once per new ASIN', async () => {
    const enrich = enrichSpy();
    enqueueCollectionEnrichment(
      [product('B000000001'), product('B000000002')],
      SESSION,
      { enrich, limit: 50 },
    );
    await whenCollectionEnrichmentIdle();

    expect(enrich).toHaveBeenCalledTimes(2);
    expect(enrich.mock.calls[0]?.[0]).toEqual({
      jobId: collectionEnrichmentJobId(SESSION, 'B000000001'),
      asin: 'B000000001',
      productUrl: 'https://www.amazon.com/dp/B000000001',
      sessionKey: SESSION,
    });
  });

  it('never redoes a product that a later batch re-sends (updatedExisting)', async () => {
    const enrich = enrichSpy();
    enqueueCollectionEnrichment([product('B000000001')], SESSION, {
      enrich,
      limit: 50,
    });
    await whenCollectionEnrichmentIdle();

    // The content script re-sends the whole run when a batch only updates rows.
    enqueueCollectionEnrichment(
      [product('B000000001'), product('B000000002')],
      SESSION,
      { enrich, limit: 50 },
    );
    await whenCollectionEnrichmentIdle();

    expect(enrich).toHaveBeenCalledTimes(2);
    expect(enrich.mock.calls.map((call) => call[0].asin)).toEqual([
      'B000000001',
      'B000000002',
    ]);
  });

  it('ignores entries with no ASIN or no URL instead of queueing an unusable job', async () => {
    const enrich = enrichSpy();
    enqueueCollectionEnrichment(
      [{ asin: 'B000000001', url: null }, { asin: null, url: 'https://x/dp/A' }],
      SESSION,
      { enrich, limit: 50 },
    );
    await whenCollectionEnrichmentIdle();
    expect(enrich).not.toHaveBeenCalled();
  });

  it('produces a deterministic job id, so the detail snapshot stays idempotent', () => {
    expect(collectionEnrichmentJobId('s1', 'B000000001')).toBe(
      collectionEnrichmentJobId('s1', 'B000000001'),
    );
    expect(collectionEnrichmentJobId('s1', 'B000000001')).not.toBe(
      collectionEnrichmentJobId('s2', 'B000000001'),
    );
    expect(collectionEnrichmentJobId('s1', 'B000000001')).toBe(
      'collect:s1:B000000001',
    );
  });
});

describe('SAD-379: enrichment pump — the per-run cap', () => {
  const many = Array.from(
    { length: 60 },
    (_, index) => product(`B${String(index).padStart(9, '0')}`),
  );

  it.each([
    [25, 25],
    [50, 50],
    [Number.POSITIVE_INFINITY, 60],
  ])('limit %s enriches %s products', async (limit, expected) => {
    const enrich = enrichSpy();
    enqueueCollectionEnrichment(many, SESSION, { enrich, limit });
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(expected);
    expect(collectionEnrichmentQueuedCount(SESSION)).toBe(expected);
  });

  it('keeps the cap across batches of the same run', async () => {
    const enrich = enrichSpy();
    enqueueCollectionEnrichment(many.slice(0, 20), SESSION, {
      enrich,
      limit: 25,
    });
    await whenCollectionEnrichmentIdle();
    enqueueCollectionEnrichment(many.slice(20, 40), SESSION, {
      enrich,
      limit: 25,
    });
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(25);
  });
});

describe('SAD-379: enrichment pump — failure is contained', () => {
  it('drains the queue on a `skipped` outcome (breaker open / no permission)', async () => {
    const enrich = vi.fn(async (): Promise<EnrichSavedProductResult> => ({
      status: 'skipped',
      fieldsChanged: [],
      snapshotCreated: false,
      currencyMismatch: false,
    }));

    enqueueCollectionEnrichment(
      [product('B000000001'), product('B000000002'), product('B000000003')],
      SESSION,
      { enrich, limit: 50 },
    );
    await whenCollectionEnrichmentIdle();

    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('a throwing enrichment never aborts the run — the next product still goes', async () => {
    const enrich = vi
      .fn<() => Promise<EnrichSavedProductResult>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(ok());

    enqueueCollectionEnrichment(
      [product('B000000001'), product('B000000002')],
      SESSION,
      { enrich, limit: 50 },
    );
    await whenCollectionEnrichmentIdle();

    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it('a failed status (not skipped) does not stop the queue', async () => {
    const enrich = vi
      .fn<() => Promise<EnrichSavedProductResult>>()
      .mockResolvedValueOnce({
        status: 'failed',
        fieldsChanged: [],
        snapshotCreated: false,
        currencyMismatch: false,
      })
      .mockResolvedValue(ok());

    enqueueCollectionEnrichment(
      [product('B000000001'), product('B000000002')],
      SESSION,
      { enrich, limit: 50 },
    );
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(2);
  });
});

describe('SAD-379: enrichment pump — run isolation', () => {
  it('reset() lets the next run enrich the same products again', async () => {
    const enrich = enrichSpy();
    enqueueCollectionEnrichment([product('B000000001')], SESSION, {
      enrich,
      limit: 50,
    });
    await whenCollectionEnrichmentIdle();

    resetCollectionEnrichment(SESSION);

    enqueueCollectionEnrichment([product('B000000001')], SESSION, {
      enrich,
      limit: 50,
    });
    await whenCollectionEnrichmentIdle();

    expect(enrich).toHaveBeenCalledTimes(2);
    expect(collectionEnrichmentQueuedCount(SESSION)).toBe(1);
  });

  it('reset() only clears its own run', async () => {
    const enrich = enrichSpy();
    enqueueCollectionEnrichment([product('B000000001')], 'run-1', {
      enrich,
      limit: 50,
    });
    await whenCollectionEnrichmentIdle();

    resetCollectionEnrichment('run-2');

    enqueueCollectionEnrichment([product('B000000001')], 'run-1', {
      enrich,
      limit: 50,
    });
    await whenCollectionEnrichmentIdle();
    expect(enrich).toHaveBeenCalledTimes(1);
  });
});
