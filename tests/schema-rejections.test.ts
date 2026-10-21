/**
 * Step 5.4 (SAD-180) — M-7: stop dropping products silently.
 * Proves (1) `collectedAt` with a +HH:MM offset is now accepted (before the
 * fix every product from users east of Greenwich could be dropped),
 * (2) each strict schema field has a deliberate near-miss behaviour,
 * (3) the background logs + counts rejections, still stores the valid
 * siblings, and reports rejected/rejectedOf on UPDATE_PROGRESS,
 * (4) an all-invalid batch still writes nothing (early return preserved) but
 * is now logged, and (5) the >10% warn decision respects the notifications
 * gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductSchema } from '@/lib/schemas/product';
import { shouldWarnAboutRejections } from '@/lib/validation-warnings';
import { validateAndNormalizeScrapedProduct } from '@/lib/scraper/field-parsers';
import { db } from '@/lib/db/database';

const baseProduct = {
  asin: 'B0VALI0001',
  url: 'https://www.amazon.com/dp/B0VALI0001',
  title: 'Valid Product',
  price: 12.5,
  currency: 'USD',
  rating: 4.2,
  reviewCount: 100,
  imageUrl: 'https://m.media-amazon.com/images/I/x.jpg',
  source: 'search' as const,
  sessionKey: 'sess-1',
  collectedAt: '2026-10-16T12:00:00.000Z',
};

describe('M-7: ProductSchema strictness is deliberate', () => {
  it('accepts collectedAt with a +HH:MM offset (the one-word fix)', () => {
    const withOffset = ProductSchema.safeParse({
      ...baseProduct,
      collectedAt: '2026-10-16T12:00:00+06:00',
    });
    expect(withOffset.success).toBe(true);
    // and Z timestamps keep working
    expect(ProductSchema.safeParse(baseProduct).success).toBe(true);
    // junk is still rejected
    expect(
      ProductSchema.safeParse({ ...baseProduct, collectedAt: 'yesterday' })
        .success
    ).toBe(false);
  });

  it('enumerates each strict field with a near-miss value', () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['rating 9 (over max)', { rating: 9 }, false],
      ['rating 5 (max boundary)', { rating: 5 }, true],
      ['rating 0 (min boundary)', { rating: 0 }, true],
      ['rating -0.1 (under min)', { rating: -0.1 }, false],
      ['reviewCount 1.5 (non-integer)', { reviewCount: 1.5 }, false],
      ['reviewCount 0', { reviewCount: 0 }, true],
      ['url not a URL', { url: 'amazon.com/dp/B0VALI0001' }, false],
      ['imageUrl null', { imageUrl: null }, true],
      ['imageUrl not a URL', { imageUrl: 'definitely-not-a-url' }, false],
      ['currency ISO code', { currency: 'EUR' }, true],
      ['currency URL junk (C-1)', { currency: 'https://x.com' }, false],
      ['asin empty', { asin: '' }, false],
      ['sessionKey empty', { sessionKey: '' }, false],
    ];
    for (const [name, patch, expected] of cases) {
      const result = ProductSchema.safeParse({ ...baseProduct, ...patch });
      expect(result.success, name).toBe(expected);
    }
  });
});

describe('M-7: shouldWarnAboutRejections (threshold + notifications gate)', () => {
  it('fires above 10% only when notifications are enabled', () => {
    expect(shouldWarnAboutRejections(2, 10, true)).toBe(true); // 20%
    expect(shouldWarnAboutRejections(1, 10, false)).toBe(false); // gate
    expect(shouldWarnAboutRejections(1, 10, true)).toBe(false); // exactly 10% → no
    expect(shouldWarnAboutRejections(0, 10, true)).toBe(false); // none rejected
    expect(shouldWarnAboutRejections(1, 0, true)).toBe(false); // empty batch
    expect(shouldWarnAboutRejections(undefined, 10, true)).toBe(false);
    expect(shouldWarnAboutRejections(1, NaN, true)).toBe(false);
  });
});

describe('M-7: validateAndNormalizeScrapedProduct logs instead of swallowing', () => {
  it('warns when normalization throws and still returns null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hostile = {
      get asin(): string {
        throw new Error('hostile getter');
      },
    } as never;
    expect(validateAndNormalizeScrapedProduct(hostile)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[PPHunt] validateAndNormalizeScrapedProduct failed:',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});

describe('M-7: background stores valid siblings and reports rejections', () => {
  let onMessageListeners: Array<(msg: any, sender?: any) => any>;
  let runtimeSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    onMessageListeners = [];
    runtimeSendMessage = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('browser', {
      sidePanel: {
        setPanelBehavior: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn() },
      },
      action: {
        setPopup: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setTitle: vi.fn().mockResolvedValue(undefined),
        onClicked: { addListener: vi.fn() },
      },
      runtime: {
        onMessage: {
          addListener: (fn: (msg: any, sender?: any) => any) => {
            onMessageListeners.push(fn);
          },
        },
        sendMessage: runtimeSendMessage,
      },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
    });
    vi.stubGlobal('defineBackground', (main: () => void) => main);
    vi.resetModules();
    const { default: main } = await import('@/entrypoints/background');
    (main as unknown as () => void)();
  });

  afterEach(async () => {
    await db.delete();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function sendCollected(products: unknown[]) {
    for (const listener of onMessageListeners) {
      listener({
        type: 'PRODUCTS_COLLECTED',
        payload: { products, totalCount: products.length, isNewBatch: true },
      });
    }
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 50));
  }

  it('stores BOTH a +06:00-offset product and a Z product (offset fix end-to-end)', async () => {
    sendCollected([
      { ...baseProduct, asin: 'B0ZULU0001', url: 'https://www.amazon.com/dp/B0ZULU0001' },
      {
        ...baseProduct,
        asin: 'B0OFFS0001',
        url: 'https://www.amazon.com/dp/B0OFFS0001',
        collectedAt: '2026-10-16T12:00:00+06:00',
      },
    ]);
    await flush();

    const stored = await db.products.toArray();
    const asins = stored.map((p) => p.asin).sort();
    expect(asins).toEqual(['B0OFFS0001', 'B0ZULU0001']); // both stored
  });

  it('logs, counts and reports rejections while storing valid siblings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendCollected([
      { ...baseProduct, asin: 'B0GOOD0001', url: 'https://www.amazon.com/dp/B0GOOD0001' },
      { ...baseProduct, asin: 'B0GOOD0002', url: 'https://www.amazon.com/dp/B0GOOD0002' },
      {
        ...baseProduct,
        asin: 'B0BADC0001',
        url: 'https://www.amazon.com/dp/B0BADC0001',
        // collectedAt passes through the normalizer untouched — a malformed
        // timestamp reaches ProductSchema and is rejected (the M-7 scenario)
        collectedAt: 'yesterday',
      },
    ]);
    await flush();

    // valid siblings stored
    const stored = await db.products.toArray();
    expect(stored.map((p) => p.asin).sort()).toEqual([
      'B0GOOD0001',
      'B0GOOD0002',
    ]);
    // logged with ASIN + issue path
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ProductSchema rejected 1/3'),
      expect.arrayContaining([
        expect.objectContaining({ asin: 'B0BADC0001', issues: expect.any(String) }),
      ])
    );
    // reported on UPDATE_PROGRESS for the panel's attention toast.
    // Scoped by session key, not "the first UPDATE_PROGRESS": the background
    // reads `browser.runtime.sendMessage` lazily, so a previous test's async
    // enrichment tail can land in *this* test's mock on a slow runner (measured
    // in CI run 39583104219 — the stale message carried sessionKey
    // 0_1792577732705 and had the same rejected/rejectedOf shape as this batch).
    const sessionKey = (stored[0] as { sessionKey?: string } | undefined)?.sessionKey;
    expect(sessionKey).toBeTruthy();
    const progress = runtimeSendMessage.mock.calls
      .map((c) => c[0] as { type?: string; payload?: Record<string, unknown> })
      .find(
        (m) => m?.type === 'UPDATE_PROGRESS' && m?.payload?.sessionKey === sessionKey
      );
    expect(progress?.payload?.rejected).toBe(1);
    expect(progress?.payload?.rejectedOf).toBe(3);
    warn.mockRestore();
  });

  it('all-invalid batch writes nothing (early return preserved) but is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendCollected([
      { ...baseProduct, asin: 'B0BADT0001', collectedAt: 'yesterday' },
      { ...baseProduct, asin: 'B0BADT0002', collectedAt: 'not-a-date' },
    ]);
    await flush();

    expect(await db.products.count()).toBe(0); // regression guard
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ProductSchema rejected 2/2'),
      expect.any(Array)
    );
    // no UPDATE_PROGRESS for an empty validated batch (behaviour preserved).
    // Scoped to this batch's shape (2 rejected of 2): a stale message from a
    // previous test's collection must not be mistaken for one of our own.
    const progress = runtimeSendMessage.mock.calls
      .map((c) => c[0] as { type?: string; payload?: Record<string, unknown> })
      .find(
        (m) =>
          m?.type === 'UPDATE_PROGRESS' &&
          m?.payload?.rejectedOf === 2 &&
          m?.payload?.rejected === 2
      );
    expect(progress).toBeUndefined();
    warn.mockRestore();
  });
});
