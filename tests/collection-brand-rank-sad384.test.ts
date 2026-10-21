import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

// Only replace the cross-context transport. Production HTML parser runs here.
vi.mock('@/engines/amazon/background/offscreen', () => ({
  parsePdpHtmlViaOffscreen: async (html: string, url: string, asin: string) => {
    const { parsePdpHtml } = await import('@/engines/amazon/offscreen/parse');
    return parsePdpHtml(html, url, asin);
  },
}));
import { db } from '@/lib/db/database';
import { createAmazonBackgroundController } from '@/engines/amazon/background/handler';
import { resetCollectionEnrichmentForTests, whenCollectionEnrichmentIdle } from '@/engines/amazon/background/enrichment-pump';
import { setEnrichCollectedSettings, resetEnrichCollectedForTests } from '@/engines/amazon/utils/enrich-collected-flag';
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
  it.each(['manual', 'automatic'] as const)('%s collects both fields with full enrichment OFF and preserves all other row values', async mode => {
    await setEnrichCollectedSettings({ enabled: false });
    const controller = await start(mode);
    await collect(controller, [card(1)]);
    const [row] = await db.products.toArray();
    expect(row).toMatchObject({ title: 'Listing title', price: 19.99, rating: 4.1, features: ['Listing feature'], isPrime: false });
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
    await setEnrichCollectedSettings({ enabled: true, limit: '50' });
    const controller = await start('automatic');
    await collect(controller, Array.from({ length: 51 }, (_, i) => card(i + 1)));
    const rows = await db.products.orderBy('asin').toArray();
    expect(rows[0]?.title).toBe('PDP title must not overwrite listing title');
    expect(rows[50]?.title).toBe('Listing title');
    expect(rows[50]?.features).toEqual(['Listing feature']);
    expect(fetched).toHaveBeenCalledTimes(51);
  });

  it('does not request a PDP when both fields already exist', async () => {
    const controller = await start('manual');
    await collect(controller, [card(1, { brand: 'Anker', bestSellersRank: '#12 in Wall Chargers' })]);
    expect(fetched).not.toHaveBeenCalled();
    expect(await db.snapshots.count()).toBe(0);
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
    expect(row).toMatchObject({ title: 'Listing title', price: 19.99, rating: 4.1, features: ['Listing feature'], isPrime: false });
  });

});
