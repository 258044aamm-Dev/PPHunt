/**
 * SAD-360 step 4 — transport, eligibility and service-worker logging.
 *
 * The contract under test:
 *  - the message schema accepts payloads with and without diagnostics, so an
 *    older content script keeps working unchanged;
 *  - exactly one `[PPHunt][Temu][Diagnostics]` line per
 *    (sessionId, goodsId, stage) — for products the session actually holds;
 *  - silence for background-rejected products, cache/dedup re-sends and
 *    repeats after a worker restart;
 *  - persistence is identical with and without diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemuProductsCollectedMessageSchema } from '@/engines/temu/schemas/messages';
import { registerTemuBackgroundHandlers } from '@/engines/temu/background/handler';
import { resetDiagnosticLedgerMemory } from '@/engines/temu/background/diagnostics-ledger';
import { TEMU_DIAGNOSTICS_LEDGER_KEY } from '@/engines/temu/constants/defaults';
import { temuDb } from '@/engines/temu/db/database';
import { getTemuProductsBySession } from '@/engines/temu/db/products';

const PREFIX = '[PPHunt][Temu][Diagnostics] ';
const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const GOODS_ID = '601099769178067';
const PAGE_URL = 'https://www.temu.com/search_result.html?search_key=earbuds';

function product(goodsId = GOODS_ID) {
  return {
    goodsId,
    asin: goodsId,
    url: `https://www.temu.com/item-g-${goodsId}.html`,
    title: 'Wireless Earbuds',
    price: 12.49,
    listPrice: null,
    discountPercentage: null,
    dealBadge: null,
    currency: 'USD',
    rating: 4.7,
    reviewCount: 1245,
    bestSellersRank: null,
    pastMonthSales: null,
    coupon: null,
    badge: null,
    delivery: null,
    imageUrl: 'https://img.kwcdn.com/product/fancy/earbuds.jpg',
    isSponsored: false,
    isPrime: false,
    brand: 'Anker',
    availability: 'In Stock',
    seller: 'AnkerDirect',
    description: null,
    features: [],
    source: 'search' as const,
  };
}

function report(
  overrides: Partial<{
    goodsId: string | null;
    stage: 'search' | 'category' | 'product_detail';
  }> = {}
) {
  return {
    goodsId: GOODS_ID,
    stage: 'search' as const,
    fields: [
      { field: 'title', status: 'EXTRACTED' as const, source: 'dom' },
      {
        field: 'rating',
        status: 'MISSING' as const,
        reason: 'no rating element',
      },
    ],
    ...overrides,
  };
}

let listeners: Array<{ map: Record<string, unknown> }> = [];

function createStorageArea(map: Record<string, unknown>) {
  return {
    get: vi.fn(async (key?: string | string[]) => {
      if (typeof key === 'string') return { [key]: map[key] };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((k) => [k, map[k]]));
      }
      return { ...map };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(map, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) delete map[k];
    }),
  };
}

function stubBrowser() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  listeners = [];
  vi.stubGlobal('browser', {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn((fn: unknown) => listeners.push(fn as never)),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 7, url: PAGE_URL }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
    storage: {
      local: createStorageArea(local),
      session: createStorageArea(session),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return { local, session };
}

function diagnosticLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith(PREFIX));
}

describe('SAD-360 step 4 — message schema compatibility', () => {
  it('accepts TEMU_PRODUCTS_COLLECTED with and without diagnostics', () => {
    const base = {
      type: 'TEMU_PRODUCTS_COLLECTED' as const,
      payload: {
        products: [],
        pageType: 'search' as const,
        pageUrl: PAGE_URL,
        totalOnPage: 24,
      },
    };
    expect(TemuProductsCollectedMessageSchema.safeParse(base).success).toBe(
      true
    );
    expect(
      TemuProductsCollectedMessageSchema.safeParse({
        ...base,
        payload: { ...base.payload, productDiagnostics: [report()] },
      }).success
    ).toBe(true);
  });

  it('accepts a null-id PDP report (D7)', () => {
    const parsed = TemuProductsCollectedMessageSchema.safeParse({
      type: 'TEMU_PRODUCTS_COLLECTED',
      payload: {
        products: [],
        pageType: 'product_detail',
        pageUrl: PAGE_URL,
        totalOnPage: 1,
        productDiagnostics: [
          report({ goodsId: null, stage: 'product_detail' }),
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown status so drift cannot slip through silently', () => {
    const parsed = TemuProductsCollectedMessageSchema.safeParse({
      type: 'TEMU_PRODUCTS_COLLECTED',
      payload: {
        products: [],
        pageType: 'search',
        pageUrl: PAGE_URL,
        totalOnPage: 1,
        productDiagnostics: [
          {
            goodsId: GOODS_ID,
            stage: 'search',
            fields: [{ field: 'title', status: 'MADE_UP' }],
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('SAD-360 step 4 — service-worker logging', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    stubBrowser();
    await temuDb.delete();
    await temuDb.open();
    resetDiagnosticLedgerMemory();
    consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await temuDb.delete();
  });

  function startSession() {
    const handlers = registerTemuBackgroundHandlers();
    handlers.handleTemuMessage(
      {
        type: 'TEMU_START_COLLECTION',
        payload: { mode: 'manual', targetCount: 50, tabId: 7, sessionId: SESSION_ID },
      },
      {},
      () => {}
    );
    return handlers;
  }

  async function collect(
    handlers: ReturnType<typeof registerTemuBackgroundHandlers>,
    payload: Record<string, unknown>
  ) {
    handlers.handleTemuMessage(
      { type: 'TEMU_PRODUCTS_COLLECTED', payload },
      { tab: { url: PAGE_URL } },
      () => {}
    );
    // The router serializes work on a promise chain; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  it('logs exactly one line per persisted product, with the resolved sessionId', async () => {
    const handlers = startSession();
    await collect(handlers, {
      products: [product()],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [report()],
    });

    const lines = diagnosticLines(consoleSpy);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.slice(PREFIX.length));
    expect(payload).toMatchObject({
      goodsId: GOODS_ID,
      sessionId: SESSION_ID,
      stage: 'search',
      counts: { extracted: 1, missing: 1, parseFailed: 0, partial: 0, unknown: 0 },
    });
  });

  it('stays silent when the message carries no diagnostics', async () => {
    const handlers = startSession();
    await collect(handlers, {
      products: [product()],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
    });
    expect(diagnosticLines(consoleSpy)).toHaveLength(0);
  });

  it('never repeats a line for the same product and stage', async () => {
    const handlers = startSession();
    for (let i = 0; i < 3; i += 1) {
      await collect(handlers, {
        products: [product()],
        pageType: 'search',
        pageUrl: PAGE_URL,
        totalOnPage: 24,
        productDiagnostics: [report()],
      });
    }
    expect(diagnosticLines(consoleSpy)).toHaveLength(1);
  });

  it('suppresses repeats after a worker restart via storage.session (A2)', async () => {
    const handlers = startSession();
    await collect(handlers, {
      products: [product()],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [report()],
    });
    expect(diagnosticLines(consoleSpy)).toHaveLength(1);

    // Simulate a worker restart: memory ledger is gone, storage.session is not.
    resetDiagnosticLedgerMemory();
    const restarted = startSession();
    await collect(restarted, {
      products: [product()],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [report()],
    });
    expect(diagnosticLines(consoleSpy)).toHaveLength(1);
  });

  it('logs nothing for a product the background rejected', async () => {
    const handlers = startSession();
    const rejected = { ...product(), goodsId: 'not-a-goods-id', asin: 'not-a-goods-id' };
    await collect(handlers, {
      products: [rejected],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [
        report({ goodsId: 'not-a-goods-id' as unknown as string }),
      ],
    });
    expect(diagnosticLines(consoleSpy)).toHaveLength(0);
  });

  it('logs nothing for a report whose product is not in the session (A3)', async () => {
    const handlers = startSession();
    await collect(handlers, {
      products: [],
      pageType: 'product_detail',
      pageUrl: PAGE_URL,
      totalOnPage: 1,
      productDiagnostics: [report({ goodsId: '601099769178999' })],
    });
    expect(diagnosticLines(consoleSpy)).toHaveLength(0);
  });

  it('logs a later-stage snapshot for a product the session already holds (A3)', async () => {
    const handlers = startSession();
    await collect(handlers, {
      products: [product()],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [report()],
    });
    expect(diagnosticLines(consoleSpy)).toHaveLength(1);

    await collect(handlers, {
      products: [],
      pageType: 'product_detail',
      pageUrl: `https://www.temu.com/item-g-${GOODS_ID}.html`,
      totalOnPage: 1,
      productDiagnostics: [report({ stage: 'product_detail' })],
    });
    const lines = diagnosticLines(consoleSpy);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!.slice(PREFIX.length)).stage).toBe(
      'product_detail'
    );
  });

  it('logs a null-id PDP report without creating a product or a session row', async () => {
    const handlers = registerTemuBackgroundHandlers();
    await collect(handlers, {
      products: [],
      pageType: 'product_detail',
      pageUrl: `https://www.temu.com/item-g-${GOODS_ID}.html`,
      totalOnPage: 1,
      productDiagnostics: [report({ goodsId: null, stage: 'product_detail' })],
    });

    const lines = diagnosticLines(consoleSpy);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.slice(PREFIX.length));
    expect(payload.goodsId).toBeNull();
    expect(await temuDb.products.count()).toBe(0);
    expect(await temuDb.sessions.count()).toBe(0);
  });

  it('persists identical products with and without diagnostics', async () => {
    const withDiag = startSession();
    await collect(withDiag, {
      products: [product('601099769178067')],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [report()],
    });
    const rowsWithDiagnostics = await getTemuProductsBySession(SESSION_ID);

    await temuDb.products.clear();
    resetDiagnosticLedgerMemory();
    const without = startSession();
    await collect(without, {
      products: [product('601099769178067')],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
    });
    const rowsWithout = await getTemuProductsBySession(SESSION_ID);

    const strip = (rows: typeof rowsWithDiagnostics) =>
      rows.map(({ id: _id, collectedAt: _c, ...rest }) => rest);
    expect(strip(rowsWithDiagnostics)).toStrictEqual(strip(rowsWithout));
    expect(rowsWithDiagnostics).toHaveLength(1);
  });

  it('keeps the ledger keyed per stage and per session', async () => {
    const handlers = startSession();
    await collect(handlers, {
      products: [product()],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [report({ stage: 'search' })],
    });
    const lines = diagnosticLines(consoleSpy);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.slice(PREFIX.length));
    expect(payload.sessionId).toBe(SESSION_ID);
    // A different stage is a different key, so it is allowed through.
    await collect(handlers, {
      products: [],
      pageType: 'product_detail',
      pageUrl: PAGE_URL,
      totalOnPage: 1,
      productDiagnostics: [report({ stage: 'product_detail' })],
    });
    expect(diagnosticLines(consoleSpy)).toHaveLength(2);
  });

  it('fails open when the ledger storage is unavailable', async () => {
    const browserStub = (globalThis as unknown as {
      browser: { storage: { session?: unknown } };
    }).browser;
    delete browserStub.storage.session;
    resetDiagnosticLedgerMemory();
    const handlers = startSession();
    await collect(handlers, {
      products: [product()],
      pageType: 'search',
      pageUrl: PAGE_URL,
      totalOnPage: 24,
      productDiagnostics: [report()],
    });
    // Without storage the in-memory layer is the only guard, but the line is
    // still emitted (owner decision: fail open, never lose diagnostics).
    expect(diagnosticLines(consoleSpy)).toHaveLength(1);
    expect(TEMU_DIAGNOSTICS_LEDGER_KEY).toBe('pphunt.temu.diagnosticsSeen');
  });
});
