import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

// Only replace the cross-context transport. Production HTML parser runs here.
/**
 * SAD-384 branched before SAD-383 merged, so this mock only knew
 * `parsePdpHtmlViaOffscreen`. `rating-backfill.ts` imports
 * `parseRatingViaOffscreen` at module load and is now reachable from the
 * controller, so the mock has to delegate the rest to the real module instead
 * of replacing it wholesale. The one override below is unchanged.
 */
vi.mock('@/engines/amazon/background/offscreen', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parsePdpHtmlViaOffscreen: async (html: string, url: string, asin: string) => {
      const { parsePdpHtml } = await import('@/engines/amazon/offscreen/parse');
      return parsePdpHtml(html, url, asin);
    },
  };
});
import { db } from '@/lib/db/database';
import { createAmazonBackgroundController } from '@/engines/amazon/background/handler';
import { resetCollectionEnrichmentForTests, whenCollectionEnrichmentIdle } from '@/engines/amazon/background/enrichment-pump';
import { updateSettings } from '@/engines/amazon/db/settings';
import { setEnrichCollectedLimit, resetEnrichCollectedForTests } from '@/engines/amazon/utils/enrich-collected-flag';
import { resetEnrichmentCircuitForTests } from '@/engines/amazon/background/enrichment-fetch';

const URL = 'https://www.amazon.com/s?k=charger';
const html = `<!doctype html><html><body>
  <span id="productTitle">PDP title must not overwrite listing title</span>
  <a id="bylineInfo">Visit the Anker Store</a>
  <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$89.99</span></span></div>
  <div id="feature-bullets"><ul><li><span class="a-list-item">PDP feature</span></li></ul></div>
  <div id="detailBulletsWrapper_feature_div">Best Sellers Rank: #12 in Wall Chargers</div>
</body></html>`;
let send: ReturnType<typeof vi.fn>;
let fetched: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await db.delete(); await db.open();
  resetCollectionEnrichmentForTests(); resetEnrichCollectedForTests(); resetEnrichmentCircuitForTests();
  // SAD-383 added an independent rating/review-count backfill, on by default. It
  // fires for any stored row whose `reviewCount` is absent — every fixture in
  // this file — and would add one popover request per product to assertions that
  // count PDP requests. Switched off here so this suite measures the brand/rank
  // fallback against full enrichment only; SAD-383's own suites cover that stage.
  await updateSettings({ backfillCollectedRatings: false });
  const values: Record<string, unknown> = {};
  const area = {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
  send = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('browser', {
    storage: { local: area, session: area },
    tabs: { get: vi.fn(async () => ({ id: 7, url: URL, status: 'complete' })), sendMessage: send },
    runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    scripting: { executeScript: vi.fn(async () => [{ result: true }]) },
    alarms: { create: vi.fn() },
  });
  fetched = vi.fn(async (url: string) => ({
    ok: true, status: 200, url,
    headers: new Headers({ 'content-type': 'text/html' }), text: async () => html,
  }));
  vi.stubGlobal('fetch', fetched);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { resetCollectionEnrichmentForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const card = (n: number, overrides = {}) => ({
  asin: `B${String(n).padStart(9, '0')}`, url: `https://www.amazon.com/dp/B${String(n).padStart(9, '0')}`,
  title: 'Listing title', price: 19.99, currency: 'USD', source: 'search',
  rating: 4.1, features: ['Listing feature'], isPrime: false,
  ...overrides,
});

async function start(mode: 'manual' | 'automatic') {
  const controller = createAmazonBackgroundController();
  controller.handleMessage({ type: 'START_COLLECTION', payload: { mode, tabId: 7, targetCount: 100 } });
  await waitFor(() => expect(send).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'COLLECT_PRODUCTS' })));
  return controller;
}
async function collect(controller: ReturnType<typeof createAmazonBackgroundController>, products: ReturnType<typeof card>[]) {
  controller.handleMessage({ type: 'PRODUCTS_COLLECTED', payload: { products, totalCount: products.length, isNewBatch: true } }, { tab: { id: 7, url: URL } });
  await waitFor(async () => {
    const rows = await db.products.toArray();
    expect(rows).toHaveLength(products.length);
    expect(rows.every(row => row.brand === 'Anker' && row.bestSellersRank === '#12 in Wall Chargers')).toBe(true);
  }, { timeout: 10000 });
  await whenCollectionEnrichmentIdle();
}

describe('SAD-384 actual controller → fetch → HTML parse → database', () => {
  it.each(['manual', 'automatic'] as const)('%s collects both fields and applies the save merge policy', async mode => {
    // SAD-385 removed the on/off switch, so the one request now serves both the
    // full detail and the brand/BSR fallback. What the row ends up with is the
    // save pipeline's merge result — asserted field by field below.
    const controller = await start(mode);
    await collect(controller, [card(1)]);
    const [row] = await db.products.toArray();
    // The listing price wins; the listing title and features are replaced by the
    // product page's, exactly as a right-click save does it.
    expect(row).toMatchObject({
      title: 'PDP title must not overwrite listing title',
      price: 19.99,
      rating: 4.1,
      features: ['PDP feature'],
      isPrime: false,
    });
    expect(row?.brand).toBe('Anker');
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(await db.snapshots.count()).toBe(1);
    // A sparse, trailing repeat must not trigger a second request.
    controller.handleMessage({ type: 'PRODUCTS_COLLECTED', payload: { products: [card(1)], totalCount: 1, isNewBatch: false } }, { tab: { id: 7, url: URL } });
    controller.handleMessage({ type: 'STOP_COLLECTION', payload: { tabId: 7 } });
    await waitFor(() => expect(send).toHaveBeenCalledWith(7, { type: 'STOP_COLLECTION_CMD' }));
    await whenCollectionEnrichmentIdle();
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('fetches missing targets after product 50, with no duplicate full/fallback requests', async () => {
    await setEnrichCollectedLimit('50');
    const controller = await start('automatic');
    await collect(controller, Array.from({ length: 51 }, (_, i) => card(i + 1)));
    const rows = await db.products.orderBy('asin').toArray();
    expect(rows[0]?.title).toBe('PDP title must not overwrite listing title');
    expect(rows[50]?.title).toBe('Listing title');
    expect(rows[50]?.features).toEqual(['Listing feature']);
    expect(fetched).toHaveBeenCalledTimes(51);
  });

  it('makes exactly one request when both fallback fields already exist', async () => {
    // SAD-385: weight/variations live only on the product page, so a complete
    // card is still fetched once — but never twice for the same two fields.
    const controller = await start('manual');
    await collect(controller, [card(1, { brand: 'Anker', bestSellersRank: '#12 in Wall Chargers' })]);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(await db.snapshots.count()).toBe(1);
  });

  it.each([[true, false], [false, true], [false, false]])('does not invent absent fields (brand=%s, rank=%s)', async (brand, rank) => {
    const partialHtml = html
      .replace(/<a id="bylineInfo">.*?<\/a>/, brand ? '<a id="bylineInfo">Visit the Anker Store</a>' : '')
      .replace(/<div id="detailBulletsWrapper_feature_div">.*?<\/div>/, rank ? '<div id="detailBulletsWrapper_feature_div">Best Sellers Rank: #12 in Wall Chargers</div>' : '');
    fetched.mockImplementation(async (url: string) => ({
      ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => partialHtml,
    }));
    const controller = await start('manual');
    controller.handleMessage({ type: 'PRODUCTS_COLLECTED', payload: { products: [card(1)], totalCount: 1, isNewBatch: true } }, { tab: { id: 7, url: URL } });
    await waitFor(async () => expect(await db.snapshots.count()).toBe(1));
    await whenCollectionEnrichmentIdle();
    const [row] = await db.products.toArray();
    expect(row?.brand ?? null).toBe(brand ? 'Anker' : null);
    expect(row?.bestSellersRank ?? null).toBe(rank ? '#12 in Wall Chargers' : null);
    expect(row).toMatchObject({ title: 'PDP title must not overwrite listing title', price: 19.99, rating: 4.1, features: ['PDP feature'], isPrime: false });
  });

});
