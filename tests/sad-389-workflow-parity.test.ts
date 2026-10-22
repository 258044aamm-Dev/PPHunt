/** SAD-389: real DOM parsers -> background handlers -> IndexedDB -> CSV/XLSX.
 * Only browser APIs and network responses are substituted. The offscreen client
 * uses its production DOMParser fallback here; Chrome messaging is tested by
 * the separate built-extension runner, not claimed by this JSDOM test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { extractProductFromCard, resolveSaveCandidate } from '@/engines/amazon/content/save-product';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import { parseAmazonCategoryPage } from '@/engines/amazon/scraper/category-page';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';
import { ASIN, SEARCH_URL, PDP_URL, cardHtml, documentOf, fixture, pdpHtml } from './fixtures/amazon-sad-389/helpers';

const LISTING = cardHtml('<p>500+ bought in past month</p><span class="s-coupon-unclipped">Save $5 with coupon</span>');
// Controlled shell combining real signal fragments; not one captured whole PDP.
const DETAIL_HTML = pdpHtml(`${fixture('pdp-sales.real.html')}${fixture('pdp-coupon.real.html')}<a id="bylineInfo">Visit the Fixture Store</a>`).replace('$59.99', '$79.99');

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
  tab: { url: SEARCH_URL, status: 'complete' },
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


beforeEach(async () => {
  vi.resetModules();
  storageState = {};
  vi.setSystemTime(new Date('2026-10-21T17:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(DETAIL_HTML, {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  })));
  const { db } = await import('@/lib/db/database');
  await db.delete();
  await db.open();
});

afterEach(async () => {
  (await import('@/lib/db/database')).db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function listingCandidates() {
  const d = documentOf(LISTING);
  const card = d.querySelector('[data-asin]')!;
  const clicked = resolveSaveCandidate({
    capture: { element: card.querySelector('h2')!, capturedAt: Date.now(), pageUrl: location.href },
    pageUrl: SEARCH_URL,
    triggeredBy: 'context-menu',
    doc: d,
  });
  return {
    collection: parseAmazonSearchResults(d, SEARCH_URL)[0]!,
    category: parseAmazonCategoryPage(d, SEARCH_URL)[0]!,
    button: extractProductFromCard(card, SEARCH_URL)!,
    clicked,
  };
}

describe('SAD-389: real-parser workflow and persistence contracts', () => {
  it('has identical target strings for search/category collection and both card-save resolvers', () => {
    const c = listingCandidates();
    for (const p of [c.collection, c.category, c.button, c.clicked?.product]) {
      expect(p).toMatchObject({ pastMonthSales: '500+ bought in past month', coupon: 'Save $5 with coupon', price: 59.99 });
    }
    expect(c.clicked?.context.triggeredBy).toBe('context-menu');
    const live = parseAmazonProductDetail(documentOf(DETAIL_HTML), PDP_URL);
    const offscreen = parsePdpHtml(DETAIL_HTML, PDP_URL, ASIN);
    expect(offscreen.ok).toBe(true);
    if (offscreen.ok) expect(offscreen.product).toEqual(live);
    expect(live).toMatchObject({ pastMonthSales: '4K+ bought in past month', coupon: 'Apply 50% coupon', price: 79.99 });
  });

  it.each(['card-button', 'context-menu'] as const)('%s and collection converge after real fetch guards / PDP parsing / enrichment', async triggeredBy => {
    const { onMessage } = await startBackground();
    const { db } = await import('@/lib/db/database');
    const c = listingCandidates();
    const product = triggeredBy === 'card-button' ? c.button : c.clicked!.product;
    drive(onMessage, { type: 'SAVE_PRODUCT', payload: {
      jobId: `sad389-${triggeredBy}`, product,
      context: { pageType: 'search', pageUrl: SEARCH_URL, triggeredBy, searchPosition: 1 },
    } });
    await waitFor(async () => {
      const rows = await db.products.where('asin').equals(ASIN).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.coupon).toBe('Apply 50% coupon');
    }, { timeout: 5000 });
    const saved = (await db.products.where('asin').equals(ASIN).toArray())[0]!;

    drive(onMessage, { type: 'PRODUCTS_COLLECTED', payload: {
      products: [c.collection], totalCount: 1, isNewBatch: true,
    } });
    const pump = await import('@/engines/amazon/background/enrichment-pump');
    await pump.whenCollectionEnrichmentIdle();
    await waitFor(async () => {
      const rows = await db.products.where('asin').equals(ASIN).toArray();
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.coupon === 'Apply 50% coupon')).toBe(true);
    }, { timeout: 5000 });
    const rows = await db.products.where('asin').equals(ASIN).toArray();
    const collected = rows.find(r => r.id !== saved.id)!;
    expect(collected.sessionKey).not.toBe(saved.sessionKey);
    for (const row of rows) {
      expect(row).toMatchObject({ coupon: 'Apply 50% coupon', pastMonthSales: '4K+ bought in past month', price: 59.99 });
      expect(row.coupon).not.toMatch(/style|padding|Shop items|Terms/);
    }
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const detailSnapshots = (await db.snapshots.toArray()).filter(s => s.source === 'detail');
    expect(detailSnapshots).toHaveLength(2);
    for (const snapshot of detailSnapshots) {
      expect(snapshot).toMatchObject({ coupon: 'Apply 50% coupon', price: 79.99 });
      expect(snapshot).not.toHaveProperty('pastMonthSales'); // existing schema, not expanded
    }

    const { buildExportFile } = await import('@/engines/amazon/offscreen/export-build');
    const { OFFSCREEN_TARGET } = await import('@/engines/amazon/offscreen/protocol');
    for (const format of ['csv', 'xlsx'] as const) {
      const file = await buildExportFile({
        target: OFFSCREEN_TARGET, type: 'OFFSCREEN_BUILD_EXPORT', format,
        products: rows, columns: ['ASIN', 'Monthly Sales', 'Coupon', 'Price'],
        filename: 'sad-389-parity', includeBOM: false, embedImages: 'never',
      });
      expect(file.ok).toBe(true);
      if (!file.ok) throw new Error(file.message);
      const book = XLSX.read(Buffer.from(file.base64, 'base64'), { type: 'buffer', raw: true });
      const exported = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]!]!, { header: 1 });
      expect(exported).toEqual([
        ['ASIN', 'Monthly Sales', 'Coupon', 'Price'],
        [ASIN, '4K+ bought in past month', 'Apply 50% coupon', format === 'csv' ? '59.99' : 59.99],
        [ASIN, '4K+ bought in past month', 'Apply 50% coupon', format === 'csv' ? '59.99' : 59.99],
      ]);
    }
  });

  it('preserves collection fill-only, quick-save refresh and null-never-erase policies', async () => {
    const { db } = await import('@/lib/db/database');
    const { addProducts } = await import('@/engines/amazon/db/products');
    const { upsertProductFromQuickSave } = await import('@/engines/amazon/db/quick-save');
    const missing = parseAmazonSearchResults(documentOf(cardHtml()), SEARCH_URL)[0]!;
    const present = listingCandidates().collection;
    const changed = parseAmazonSearchResults(documentOf(LISTING.replace('500+', '900+').replace('Save $5', 'Save $9')), SEARCH_URL)[0]!;
    const session = 'sad389-policy';
    await addProducts([missing], session);
    await addProducts([present], session);
    let row = (await db.products.toArray())[0]!;
    expect(row).toMatchObject({ pastMonthSales: '500+ bought in past month', coupon: 'Save $5 with coupon' });
    await addProducts([changed, missing], session);
    expect((await db.products.toArray())[0]).toEqual(row);
    await upsertProductFromQuickSave(changed, session);
    row = (await db.products.toArray())[0]!;
    expect(row).toMatchObject({ pastMonthSales: '900+ bought in past month', coupon: 'Save $9 with coupon' });
    await upsertProductFromQuickSave(missing, session);
    expect((await db.products.toArray())[0]).toEqual(row);
    expect(await db.products.count()).toBe(1);
  });

  it('keeps brand-and-rank enrichment restricted even when the real PDP carries targets', async () => {
    const { db } = await import('@/lib/db/database');
    const { addProducts } = await import('@/engines/amazon/db/products');
    const { enrichSavedProduct } = await import('@/engines/amazon/background/enrich-saved-product');
    await addProducts([listingCandidates().collection], 'sad389-restricted');
    const result = await enrichSavedProduct({ jobId: 'sad389-restricted', asin: ASIN, productUrl: PDP_URL, sessionKey: 'sad389-restricted', scope: 'brand-and-rank' });
    expect(result.fieldsChanged).not.toContain('coupon');
    expect(result.fieldsChanged).not.toContain('pastMonthSales');
    expect((await db.products.toArray())[0]).toMatchObject({ coupon: 'Save $5 with coupon', pastMonthSales: '500+ bought in past month', price: 59.99 });
  });

  it('retains absent targets when the PDP has no signal, without turning missing into zero', async () => {
    const { db } = await import('@/lib/db/database');
    const { addProducts } = await import('@/engines/amazon/db/products');
    const { enrichSavedProduct } = await import('@/engines/amazon/background/enrich-saved-product');
    const missing = parseAmazonSearchResults(documentOf(cardHtml()), SEARCH_URL)[0]!;
    await addProducts([missing], 'sad389-absent');
    vi.mocked(fetch).mockImplementation(async () => new Response(pdpHtml(), { headers: { 'content-type': 'text/html' } }));
    await enrichSavedProduct({ jobId: 'sad389-absent', asin: ASIN, productUrl: PDP_URL, sessionKey: 'sad389-absent' });
    const row = (await db.products.toArray())[0]!;
    expect(row.coupon).toBeUndefined();
    expect(row.pastMonthSales).toBeUndefined();
  });
});
