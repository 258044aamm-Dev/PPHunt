/**
 * SAD-379 step 3 — the ticket's acceptance criterion, stated differentially.
 *
 * The same listing card, given to the save pipeline and to the collection
 * pipeline, must end as the same product row. Before this ticket it did not:
 * a save continued into the product-page fetch and merged the detail fields, a
 * collection stopped at the card (measured: 7 fields collected vs a median of
 * 19 saved).
 *
 * Everything here runs through the **real** background listener and the real
 * `enrichSavedProduct`; only the network is replaced (one canned PDP), so a
 * green test means the two paths genuinely converge rather than that two mocks
 * agree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirror the loose listener signatures */

/** The product-detail page both paths will "fetch". */
const DETAIL = {
  title: 'Anker 65W Fast Wall Charger (detail title)',
  price: 39.99,
  listPrice: 49.99,
  discountPercentage: '-20%',
  currency: 'USD',
  rating: 4.6,
  reviewCount: 1204,
  bestSellersRank: '#12 in Wall Chargers',
  availability: 'In Stock',
  seller: 'AnkerDirect',
  brand: 'Anker',
  description: 'A 65 W USB-C charger.',
  features: ['65 W', 'Compact'],
  weight: '120 g',
  warrantyDescription: '24 months',
  coupon: 'Save 10%',
  delivery: 'FREE delivery Tomorrow',
  pastMonthSales: '10K+ bought in past month',
  badge: 'Amazon’s Choice',
  variations: '2 sizes',
  imageUrl: 'https://m.media-amazon.com/images/I/detail.jpg',
};

vi.mock('@/engines/amazon/background/enrichment-fetch', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The real `fetchPdpHtml` returns an `EnrichmentOutcome`, not a Response.
    fetchPdpHtml: vi.fn(async (url: string) => ({
      status: 'ok' as const,
      html: '<html><body>pdp</body></html>',
      finalUrl: url,
      httpStatus: 200,
    })),
  };
});

vi.mock('@/engines/amazon/background/offscreen', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parsePdpHtmlViaOffscreen: vi.fn(async (_html: string, url: string) => ({
      ok: true as const,
      product: {
        asin: (url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? 'B000000000') as string,
        url,
        source: 'detail' as const,
        ...DETAIL,
      },
    })),
  };
});

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

let storageState: Record<string, unknown>;

async function startBackground() {
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
        get: vi.fn(async () => ({ ...storageState })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(storageState, items);
        }),
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
  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
  await waitFor(() => expect(mockBrowser.action.setPopup).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { onMessage, browser: mockBrowser };
}

const SENDER = {
  id: 1,
  tab: { url: 'https://www.amazon.com/s?k=charger', status: 'complete' },
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

/** The listing card, freshly parsed — identical for both pipelines. */
function card(asin: string) {
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: 'Anker 65W Charger — listing title',
    price: 19.99,
    currency: 'USD',
    rating: 4.4,
    reviewCount: 900,
    imageUrl: 'https://m.media-amazon.com/images/I/card.jpg',
    isSponsored: false,
    isPrime: true,
    brand: 'Anker',
    availability: 'In Stock',
    features: ['65W'],
    source: 'search' as const,
    listingCategory: 'organic' as const,
    sectionLabel: 'Results',
    placements: ['search'],
  };
}

const SAVE_CONTEXT = {
  pageType: 'search' as const,
  pageUrl: 'https://www.amazon.com/s?k=charger',
  triggeredBy: 'card-button' as const,
  searchPosition: 1,
  listingCategory: 'organic' as const,
  sectionLabel: 'Results',
};

async function rowsFor(asin: string) {
  const { db } = await import('@/lib/db/database');
  return db.products.where('asin').equals(asin).toArray();
}

async function rowFor(asin: string) {
  const rows = await rowsFor(asin);
  return rows[0];
}

/** Waits until a row exists *and* carries the detail-page rating. */
async function waitEnriched(asin: string) {
  await waitFor(
    async () => {
      const rows = await rowsFor(asin);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.rating === DETAIL.rating)).toBe(true);
    },
    { timeout: 5000 },
  );
}

async function saveProduct(
  onMessage: ReturnType<typeof event>,
  product: ReturnType<typeof card>,
) {
  drive(onMessage, {
    type: 'SAVE_PRODUCT',
    payload: {
      jobId: `job-${product.asin}`,
      product,
      context: SAVE_CONTEXT,
    },
  });
  await waitEnriched(product.asin);
  const rows = await rowsFor(product.asin);
  return rows[rows.length - 1];
}

async function collectProduct(
  onMessage: ReturnType<typeof event>,
  product: ReturnType<typeof card>,
  excludeId?: number,
) {
  const pump = await import('@/engines/amazon/background/enrichment-pump');
  drive(onMessage, {
    type: 'PRODUCTS_COLLECTED',
    payload: { products: [product], totalCount: 1, isNewBatch: true },
  });
  await pump.whenCollectionEnrichmentIdle();
  await waitFor(
    async () => {
      const rows = (await rowsFor(product.asin)).filter(
        (row) => row.id !== excludeId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rating).toBe(DETAIL.rating);
    },
    { timeout: 5000 },
  );
  const rows = (await rowsFor(product.asin)).filter(
    (row) => row.id !== excludeId,
  );
  return rows[0];
}

/**
 * Keys that are identities or provenance rather than product data. Each one is
 * a deliberate exclusion, not a convenience:
 * - `id` — a primary key;
 * - `sessionKey` — a save and a collection are different runs by definition;
 * - `collectedAt` — pinned identical with a frozen clock below, so it is kept.
 */
const NON_PRODUCT_KEYS = ['id', 'sessionKey'] as const;

function comparable(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const source = (row ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if ((NON_PRODUCT_KEYS as readonly string[]).includes(key)) continue;
    out[key] = source[key];
  }
  return out;
}

beforeEach(async () => {
  storageState = {};
  vi.resetModules();
  vi.setSystemTime(new Date('2026-10-21T09:00:00.000Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db } = await import('@/lib/db/database');
  await db.delete();
  await db.open();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SAD-379: a collected row equals a saved row', () => {
  it('the same card yields the same product row through both pipelines', async () => {
    const { onMessage } = await startBackground();
    const flag = await import('@/engines/amazon/utils/enrich-collected-flag');

    // One card, one ASIN, two runs: a save (its own session) and a collection
    // (a different session). Same input, so any difference is the pipeline's.
    const ASIN = 'B0000000AA';
    const saved = await saveProduct(onMessage, card(ASIN));

    await flag.setEnrichCollectedSettings({ enabled: true, limit: '50' });
    const collected = await collectProduct(onMessage, card(ASIN), saved?.id);

    // Different runs...
    expect(collected?.sessionKey).not.toBe(saved?.sessionKey);
    // ...and the same product, field for field.
    expect(comparable(collected)).toEqual(comparable(saved));

    // Not merely equal to each other — equal to the enriched shape: the card's
    // fields plus the detail page's, with the listing price still winning.
    expect(collected?.rating).toBe(DETAIL.rating);
    expect(collected?.reviewCount).toBe(DETAIL.reviewCount);
    expect(collected?.seller).toBe(DETAIL.seller);
    expect(collected?.description).toBe(DETAIL.description);
    expect(collected?.weight).toBe(DETAIL.weight);
    expect(collected?.warrantyDescription).toBe(DETAIL.warrantyDescription);
    expect(collected?.price).toBe(19.99);
  });

  it('both pipelines publish exactly one detail snapshot for the product', async () => {
    const { onMessage } = await startBackground();
    const flag = await import('@/engines/amazon/utils/enrich-collected-flag');
    const { db } = await import('@/lib/db/database');

    await saveProduct(onMessage, card('B0000000CC'));
    await flag.setEnrichCollectedSettings({ enabled: true, limit: '50' });
    await collectProduct(onMessage, card('B0000000DD'));

    const snapshots = await db.snapshots.toArray();
    const detailSnapshots = snapshots.filter((s) => s.source === 'detail');
    expect(detailSnapshots.map((s) => s.asin).sort()).toEqual([
      'B0000000CC',
      'B0000000DD',
    ]);
  });

  it('with the switch off only missing brand/BSR enrich the collected row', async () => {
    const { onMessage } = await startBackground();
    const { db } = await import('@/lib/db/database');

    drive(onMessage, {
      type: 'PRODUCTS_COLLECTED',
      payload: { products: [card('B0000000EE')], totalCount: 1, isNewBatch: true },
    });

    await waitFor(async () =>
      expect(await db.products.where('asin').equals('B0000000EE').count()).toBe(1),
    );
    await waitFor(async () => expect((await rowFor('B0000000EE'))?.bestSellersRank).toBe(DETAIL.bestSellersRank));
    const row = await rowFor('B0000000EE');
    // Other detail fields remain opt-in.
    expect(row?.seller ?? null).toBeNull();
    expect(row?.description ?? null).toBeNull();
    expect(row?.weight).toBeUndefined();
    expect(await db.snapshots.count()).toBe(1);
  });
});
