/**
 * SAD-379 step 1 / SAD-385 — wiring: the collection pipeline always calls the
 * save pipeline's enrichment stage, bounded by the per-run budget.
 *
 * This drives the **real** background listener (`@/entrypoints/background`),
 * exactly as `background-router-robustness.test.ts` does, so what is asserted is
 * the production message path and not a re-implementation.
 *
 * The save pipeline's `enrichSavedProduct` is mocked, because this test is about
 * *whether and how often* collection calls it — the function's own behaviour is
 * covered by `tests/enrich-saved-product.test.ts`.
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

/**
 * `storage.onChanged` has more than one subscriber in the worker, so this
 * harness keeps every listener instead of only the last one.
 */
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

/**
 * Boots the real entrypoint. `stored` is what `storage.local.get` reports for
 * the enrichment key, so the budget is driven the way production drives it: the
 * start-up read in `src/entrypoints/background.ts`.
 *
 * SAD-385: the value is `{ limit }` — there is no switch any more, and `'all'`
 * is the default a fresh install runs with.
 */
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

  // Imported after the globals are stubbed, and before the entrypoint, so both
  // resolve to the same module instance.
  const flag = await import('@/engines/amazon/utils/enrich-collected-flag');
  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
  await waitFor(() => expect(mockBrowser.action.setPopup).toHaveBeenCalled());
  // Let the start-up settings read settle before the test drives any message.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { browser: mockBrowser, onMessage, flag };
}

const SENDER = {
  id: 1,
  tab: { url: 'https://www.amazon.com/deals', status: 'complete' },
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

function collected(products: Array<{ asin: string }>) {
  return {
    type: 'PRODUCTS_COLLECTED',
    payload: {
      products: products.map(({ asin }) => ({
        asin,
        title: `Product ${asin}`,
        url: `https://www.amazon.com/dp/${asin}`,
        price: 19.99,
        currency: 'USD',
        imageUrl: 'https://m.media-amazon.com/images/I/x.jpg',
        source: 'category',
      })),
      totalCount: products.length,
      isNewBatch: true,
    },
  };
}

/**
 * Distinct ASINs per test: the collection path de-duplicates against rows that
 * already exist, so reusing an ASIN across tests would hide a missing write.
 */
let asinBase = 0;
const ASINS = (count: number) => {
  const start = asinBase;
  asinBase += count;
  return Array.from({ length: count }, (_, index) => ({
    asin: `B${String(start + index).padStart(9, '0')}`,
  }));
};

beforeEach(() => {
  vi.resetModules();
  enrichSavedProduct.mockReset();
  enrichSavedProduct.mockResolvedValue({
    status: 'complete',
    fieldsChanged: ['rating'],
    snapshotCreated: true,
    currencyMismatch: false,
  });
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

describe('SAD-385: a collection always runs the save pipeline stage', () => {
  it('enriches every collected product with no setting touched', async () => {
    const { db } = await import('@/lib/db/database');
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/enrichment-pump');

    const before = await db.products.count();
    drive(onMessage, collected(ASINS(3)));
    await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(3));
    await pump.whenCollectionEnrichmentIdle();
    await waitFor(async () => expect(await db.products.count()).toBe(before + 3));
  });

  it('the budget defaults to "all" with no stored value', async () => {
    await startBackground();
    const flag = await import('@/engines/amazon/utils/enrich-collected-flag');
    // This is the ticket: nothing has to be switched on for a collection to
    // reach the product page that carries weight and variations.
    expect(flag.getEnrichCollectedLimit()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('SAD-379: collection runs the save pipeline stage', () => {
  it('enriches each collected product through the same function the save path uses', async () => {
    const { onMessage } = await startBackground({ limit: '50' });
    const pump = await import('@/engines/amazon/background/enrichment-pump');

    const asins = ASINS(3);
    drive(onMessage, collected(asins));
    await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(3));
    await pump.whenCollectionEnrichmentIdle();

    const call = enrichSavedProduct.mock.calls[0]?.[0] as {
      jobId: string;
      asin: string;
      sessionKey: string;
    };
    expect(enrichSavedProduct.mock.calls.map((c) => (c[0] as { asin: string }).asin)).toEqual(
      asins.map((p) => p.asin),
    );
    expect(call.jobId).toBe(`collect:${call.sessionKey}:${call.asin}`);
    expect(call.sessionKey).toBeTruthy();
  });

  it('honours the 25 full-detail cap and falls back beyond it', async () => {
    const { onMessage } = await startBackground({ limit: '25' });
    const pump = await import('@/engines/amazon/background/enrichment-pump');

    drive(onMessage, collected(ASINS(40)));
    await waitFor(() => expect(enrichSavedProduct).toHaveBeenCalledTimes(40));
    await pump.whenCollectionEnrichmentIdle();
    // The cap is a ceiling, not a batch size: no 26th call ever arrives.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enrichSavedProduct.mock.calls.filter(([input]) => !input.scope)).toHaveLength(25);
    expect(enrichSavedProduct.mock.calls.filter(([input]) => input.scope === 'brand-and-rank')).toHaveLength(15);
  });

  it('is never awaited by the collection message path (a slow fetch cannot block progress)', async () => {
    const { db } = await import('@/lib/db/database');
    // An enrichment that never resolves: the collection must not depend on it.
    enrichSavedProduct.mockImplementation(() => new Promise(() => {}));
    const { onMessage } = await startBackground({ limit: '50' });
    const pump = await import('@/engines/amazon/background/enrichment-pump');

    const before = await db.products.count();
    const { result, sendResponse } = drive(onMessage, collected(ASINS(1)));

    // The handler answered and returned immediately, before any enrichment.
    expect(result).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await waitFor(async () => expect(await db.products.count()).toBe(before + 1));

    void pump; // the pending run is intentionally left hanging for this test
  });
});

describe('SAD-385: the budget cache', () => {
  it('maps the enum to a numeric limit and falls back to the default', async () => {
    const { flag } = await startBackground();

    expect(flag.resolveEnrichCollectedLimit('25')).toBe(25);
    expect(flag.resolveEnrichCollectedLimit('50')).toBe(50);
    expect(flag.resolveEnrichCollectedLimit('all')).toBe(Number.POSITIVE_INFINITY);

    // A corrupt stored value falls back to the default rather than throwing.
    expect(flag.readEnrichCollected({ enabled: 'yes', limit: 'lots' })).toEqual({
      limit: 'all',
    });
    expect(flag.readEnrichCollected(null)).toEqual({ limit: 'all' });
  });

  it('keeps a budget a user actually chose, and ignores the old off switch', async () => {
    const { flag } = await startBackground();

    // SAD-379's shape: the user switched enrichment on and picked 25.
    expect(flag.readEnrichCollected({ enabled: true, limit: '25' })).toEqual({
      limit: '25',
    });
    // SAD-379's factory value: nobody chose it, so it moves to the new default.
    expect(flag.readEnrichCollected({ enabled: false, limit: '50' })).toEqual({
      limit: 'all',
    });
    // The new writer's own shape.
    expect(flag.readEnrichCollected({ limit: '50' })).toEqual({ limit: '50' });
  });

  it('takes effect live when the budget changes, with no worker restart', async () => {
    const { browser, flag } = await startBackground({ limit: '25' });
    expect(flag.getEnrichCollectedLimit()).toBe(25);

    // Settings writes `storage.local`; the worker picked up `onChanged` at boot.
    browser.storage.onChanged.emit(
      {
        pphuntEnrichCollected: { newValue: { limit: 'all' } },
      },
      'local',
    );

    expect(flag.getEnrichCollectedLimit()).toBe(Number.POSITIVE_INFINITY);
  });
});
