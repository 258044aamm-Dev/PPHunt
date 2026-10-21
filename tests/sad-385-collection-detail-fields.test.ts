/**
 * SAD-385 — the ticket's own wording, tested end to end.
 *
 * The ticket says weight and variation data are missing "when scraping products
 * through Collection Mode, regardless of whether Manual Mode or Automatic Mode
 * is used", and asks for a fix that does not regress right-click or the
 * individual extraction icon.
 *
 * So this file proves, in the ticket's terms:
 * - T1/T2 — a Manual run and an Automatic run reach the same enrichment stage,
 *   with the same inputs (the two modes differ only in how the page scrolls);
 * - T5 — a run that lost its enrichment tail (the pump's queue is in memory, so
 *   an MV3 suspension drops it) re-derives the tail from the rows at the run
 *   boundary, and touches only rows still missing a detail-only field;
 * - T6 — the reconciliation is idempotent: a second run boundary does not queue
 *   the same tail again;
 * - T7 — a failing enrichment is never a collection error: the rows are stored
 *   and the run continues.
 *
 * The harness is the real background entrypoint driven through `runtime.
 * onMessage`, exactly as `collection-enrichment-wiring.test.ts` does. Only
 * `enrichSavedProduct` is stubbed — its own behaviour belongs to
 * `tests/enrich-saved-product.test.ts`, and the true parity proof lives in
 * `tests/collection-save-parity.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirror the loose listener signatures */

const enrichSavedProduct = vi.fn();

vi.mock('@/engines/amazon/background/enrich-saved-product', () => ({
  enrichSavedProduct: (...args: unknown[]) => enrichSavedProduct(...args),
  MAX_CONCURRENT_ENRICHMENTS: 2,
  PRICE_FAMILY: new Set<string>(),
  mergeDetailIntoStored: vi.fn(),
  collectMissingDetailFields: vi.fn(() => []),
  collectPresentDetailFields: vi.fn(() => []),
  resetEnrichmentConcurrencyForTests: vi.fn(),
}));

type Listener = (...args: any[]) => any;

function event() {
  const listeners: Listener[] = [];
  return {
    addListener: vi.fn((callback: Listener) => {
      listeners.push(callback);
    }),
    removeListener: vi.fn((callback: Listener) => {
      const index = listeners.indexOf(callback);
      if (index >= 0) listeners.splice(index, 1);
    }),
    emit: (...args: any[]) => {
      for (const listener of [...listeners]) listener(...args);
    },
    current: () => listeners[0] ?? (() => {}),
  };
}

async function startBackground(stored: { limit: string } = { limit: 'all' }) {
  const onMessage = event();
  const mockBrowser = {
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setPopup: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      onClicked: event(),
    },
    storage: {
      local: {
        get: vi.fn().mockImplementation(async () => ({
          pphuntEnrichCollected: stored,
        })),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: event(),
    },
    tabs: {
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([
        { id: 1, url: 'https://www.amazon.com/s?k=charger' },
      ]),
      get: vi.fn().mockResolvedValue({
        id: 1,
        url: 'https://www.amazon.com/s?k=charger',
      }),
    },
    runtime: {
      onMessage,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getURL: vi.fn().mockReturnValue('chrome-extension://x/overlay.html'),
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
  };
  vi.stubGlobal('browser', mockBrowser);
  vi.stubGlobal('defineBackground', (main: () => void) => main);

  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
  await waitFor(() => expect(mockBrowser.action.setPopup).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { browser: mockBrowser, onMessage };
}

const SENDER = {
  id: 1,
  tab: { id: 1, url: 'https://www.amazon.com/deals', status: 'complete' },
};

function drive(onMessage: ReturnType<typeof event>, message: unknown) {
  const sendResponse = vi.fn();
  const listener = onMessage.current() as (
    message: unknown,
    sender: unknown,
    respond: (response?: unknown) => void,
  ) => unknown;
  const result = listener(message, SENDER, sendResponse);
  return { result, sendResponse };
}

const CARD_FIELDS = {
  title: 'Product',
  price: 19.99,
  currency: 'USD',
  imageUrl: 'https://m.media-amazon.com/images/I/x.jpg',
  source: 'category',
};

function product(asin: string) {
  return { asin, url: `https://www.amazon.com/dp/${asin}`, ...CARD_FIELDS };
}

function collected(asins: string[], isNewBatch = true) {
  return {
    type: 'PRODUCTS_COLLECTED',
    payload: {
      products: asins.map(product),
      totalCount: asins.length,
      isNewBatch,
    },
  };
}

const ENRICHED = {
  status: 'complete' as const,
  fieldsChanged: ['weight', 'variations'],
  snapshotCreated: true,
  currencyMismatch: false,
};

/** Distinct ASINs per test: the collection path de-duplicates per session. */
let asinBase = 0;
function asins(count: number): string[] {
  const start = asinBase;
  asinBase += count;
  return Array.from({ length: count }, (_, index) =>
    `B${String(start + index).padStart(9, '0')}`,
  );
}

function calledAsins(): string[] {
  return enrichSavedProduct.mock.calls.map(
    (call) => (call[0] as { asin: string }).asin,
  );
}

beforeEach(async () => {
  vi.resetModules();
  // Rows are the durable state under test, so every case starts from an empty DB.
  const { db } = await import('@/lib/db/database');
  await db.delete();
  await db.open();
  const pump = await import('@/engines/amazon/background/enrichment-pump');
  pump.resetCollectionEnrichmentForTests();
  enrichSavedProduct.mockReset();
  enrichSavedProduct.mockResolvedValue(ENRICHED);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  const pump = await import('@/engines/amazon/background/enrichment-pump');
  pump.resetCollectionEnrichmentForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SAD-385: both collection modes reach the product page', () => {
  /**
   * The ticket's "regardless of whether Manual Mode or Automatic Mode is used".
   * `mode` only selects the scroll driver in the content script, so the two
   * runs must produce *identical* enrichment inputs apart from the session key.
   */
  it('a Manual run and an Automatic run enrich identically', async () => {
    const runInMode = async (mode: 'manual' | 'automatic') => {
      const { onMessage } = await startBackground();
      const pump = await import('@/engines/amazon/background/enrichment-pump');
      const [asin] = asins(1);

      drive(onMessage, {
        type: 'START_COLLECTION',
        payload: { mode, targetCount: 50, tabId: 1 },
      });
      // Let the collection start settle before the batch arrives, as the
      // content script does (it only scrapes after `COLLECT_PRODUCTS`).
      await new Promise((resolve) => setTimeout(resolve, 10));

      drive(onMessage, collected([asin!]));
      await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(1));
      await pump.whenCollectionEnrichmentIdle();

      const input = enrichSavedProduct.mock.calls[0]?.[0] as {
        jobId: string;
        asin: string;
        productUrl: string;
        sessionKey: string;
      };
      enrichSavedProduct.mockReset();
      enrichSavedProduct.mockResolvedValue(ENRICHED);
      return input;
    };

    const manual = await runInMode('manual');
    const automatic = await runInMode('automatic');

    // Same treatment in both modes: the same four inputs, derived the same way,
    // and a job id that is a pure function of the run and the product. Only the
    // run's identity (and therefore the ASIN, which each run invents) differs.
    expect(Object.keys(manual).sort()).toEqual(Object.keys(automatic).sort());
    expect(manual.jobId).toBe(`collect:${manual.sessionKey}:${manual.asin}`);
    expect(automatic.jobId).toBe(
      `collect:${automatic.sessionKey}:${automatic.asin}`,
    );
    expect(manual.productUrl).toBe(`https://www.amazon.com/dp/${manual.asin}`);
    expect(automatic.productUrl).toBe(
      `https://www.amazon.com/dp/${automatic.asin}`,
    );
    expect(manual.sessionKey).not.toBe(automatic.sessionKey);
  });
});

describe('SAD-385: the run-end reconciliation', () => {
  /**
   * Simulated suspension: the rows persist, the pump's in-memory queue, dedupe
   * set and budget do not. After a worker restart the run boundary must derive
   * the tail from the rows — that is the only durable record.
   */
  it('queues only the rows still missing a detail-only field', async () => {
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/enrichment-pump');
    const { db } = await import('@/lib/db/database');
    const [done, missingWeight, missingBoth] = asins(3);

    drive(onMessage, collected([done!, missingWeight!, missingBoth!]));
    await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(3));
    await pump.whenCollectionEnrichmentIdle();

    // One row reached full detail before the suspension…
    await db.products
      .where('asin')
      .equals(done!)
      .modify({ weight: '120 g', variations: '2 sizes' });
    // …one has the twister data but no weight…
    await db.products
      .where('asin')
      .equals(missingWeight!)
      .modify({ variations: '2 sizes' });
    // …and one has neither.

    // The worker restarts: module state is gone, the rows are not.
    pump.resetCollectionEnrichmentForTests();
    enrichSavedProduct.mockClear();

    drive(onMessage, { type: 'STOP_COLLECTION', payload: { tabId: 1 } });
    await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(2));
    await pump.whenCollectionEnrichmentIdle();

    expect(calledAsins().sort()).toEqual([missingWeight!, missingBoth!].sort());
    // The complete row is not fetched again.
    expect(calledAsins()).not.toContain(done!);
  });

  it('does not queue the same tail twice', async () => {
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/enrichment-pump');
    const [first] = asins(1);

    drive(onMessage, collected([first!]));
    await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(1));
    await pump.whenCollectionEnrichmentIdle();

    pump.resetCollectionEnrichmentForTests();
    enrichSavedProduct.mockClear();

    drive(onMessage, { type: 'STOP_COLLECTION', payload: { tabId: 1 } });
    await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(1));
    await pump.whenCollectionEnrichmentIdle();
    const afterStop = enrichSavedProduct.mock.calls.length;

    // A duplicate run boundary — the second STOP finds the session already
    // reconciled and must not re-fetch anything.
    drive(onMessage, { type: 'STOP_COLLECTION', payload: { tabId: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(enrichSavedProduct.mock.calls.length).toBe(afterStop);
  });
});

describe('SAD-385: a failing enrichment is never a collection error', () => {
  it('stores every product and lets the run continue', async () => {
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/enrichment-pump');
    const { db } = await import('@/lib/db/database');
    const batch = asins(3);
    enrichSavedProduct.mockRejectedValue(new Error('fetch exploded'));

    drive(onMessage, collected(batch));
    await waitFor(async () => expect(await db.products.count()).toBe(3));
    await pump.whenCollectionEnrichmentIdle();

    // The rows exist, at card quality, and the message path answered `ok`.
    const { sendResponse } = drive(onMessage, collected(asins(1)));
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await waitFor(async () => expect(await db.products.count()).toBe(4));
  });
});
