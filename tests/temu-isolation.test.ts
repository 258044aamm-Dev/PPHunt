import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from '@/entrypoints/sidepanel/App';
import { db } from '@/lib/db/database';
import { temuDb } from '@/engines/temu/db/database';
import {
  upsertTemuProducts,
  getTemuProductsBySession,
  clearAllTemuProducts,
} from '@/engines/temu/db/products';
import {
  createTemuSession,
  getTemuSession,
} from '@/engines/temu/db/sessions';
import {
  writeActiveTemuSession,
  readActiveTemuSession,
  clearActiveTemuSession,
} from '@/engines/temu/db/session-state';
import {
  getTemuSettings,
  updateTemuSettings,
} from '@/engines/temu/db/settings';
import { buildTemuCSVContent } from '@/engines/temu/export/csv';
import { buildTemuClipboardTSV } from '@/engines/temu/export/clipboard';
import { registerTemuBackgroundHandlers } from '@/engines/temu/background/handler';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useTemuCollectionStore } from '@/engines/temu/ui/store/collectionStore';
import {
  TEMU_ACTIVE_SESSION_KEY,
  TEMU_DB_NAME,
} from '@/engines/temu/constants/defaults';

describe('Engine Isolation: PPHuntDB (Amazon) vs PPHuntTemuDB (Temu) (SAD-223)', () => {
  let localStorageMap: Record<string, unknown>;
  let sessionStorageMap: Record<string, unknown>;

  beforeEach(async () => {
    localStorageMap = {};
    sessionStorageMap = {};

    const createStorageArea = (map: Record<string, unknown>) => ({
      get: vi.fn(async (key?: string | string[]) => {
        if (typeof key === 'string') {
          return { [key]: map[key] };
        }
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map((k) => [k, map[k]]));
        }
        return { ...map };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(map, items);
      }),
      remove: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) {
          delete map[k];
        }
      }),
    });

    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 301,
            url: 'https://www.amazon.com/s?k=wireless+mouse',
          },
        ]),
        get: vi.fn().mockResolvedValue({
          id: 301,
          url: 'https://www.temu.com/search_result.html?search_key=earbuds',
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: true }]),
      },
      storage: {
        local: createStorageArea(localStorageMap),
        session: createStorageArea(sessionStorageMap),
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });

    await db.delete();
    await db.open();
    await temuDb.delete();
    await temuDb.open();

    useCollectionStore.getState().reset();
    useTemuCollectionStore.getState().reset();
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    await temuDb.delete();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps IndexedDB databases (PPHuntDB vs PPHuntTemuDB) completely isolated across products, sessions, and settings', async () => {
    expect(db.name).toBe('PPHuntDB');
    expect(temuDb.name).toBe(TEMU_DB_NAME);
    expect(db.name).not.toBe(temuDb.name);

    // 1. Add an Amazon product to PPHuntDB
    await db.products.add({
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      title: 'Amazon Only Product',
      price: 49.99,
      currency: 'USD',
      rating: 4.7,
      reviewCount: 1200,
      imageUrl: null,
      isSponsored: false,
      isPrime: true,
      brand: 'Anker',
      availability: 'In Stock',
      seller: 'AnkerDirect',
      description: null,
      features: [],
      collectedAt: '2026-10-17T10:00:00.000Z',
      source: 'search',
      sessionKey: 'amazon-session-1',
    });

    // 2. Add a Temu product and session to PPHuntTemuDB
    const temuSessionId = await createTemuSession(
      301,
      'https://www.temu.com/search_result.html?search_key=earbuds',
      'manual',
      50,
      'search',
      'earbuds'
    );

    await upsertTemuProducts([
      {
        goodsId: '601099769178067',
        asin: '601099769178067',
        url: 'https://www.temu.com/wireless-earbuds-g-601099769178067.html',
        title: 'Temu Only Wireless Earbuds',
        price: 9.48,
        listPrice: 24.99,
        discountPercentage: '62% off',
        currency: 'USD',
        rating: 4.8,
        reviewCount: 840,
        pastMonthSales: '10K+ sold',
        badge: null,
        dealBadge: 'Lightning deal',
        bestSellersRank: null,
        coupon: null,
        delivery: 'Free shipping',
        imageUrl: 'https://img.kwcdn.com/product/fancy/earbuds.jpg',
        isSponsored: false,
        isPrime: false,
        brand: null,
        availability: 'In Stock',
        seller: 'TemuAudio',
        description: null,
        features: [],
        collectedAt: '2026-10-17T10:05:00.000Z',
        source: 'search',
        sessionId: temuSessionId,
      },
    ]);

    // Verify zero cross-contamination
    const amazonProducts = await db.products.toArray();
    const temuProducts = await getTemuProductsBySession(temuSessionId);
    expect(amazonProducts).toHaveLength(1);
    expect(amazonProducts[0]?.asin).toBe('B08N5WRWNW');
    expect(temuProducts).toHaveLength(1);
    expect(temuProducts[0]?.goodsId).toBe('601099769178067');

    // Clearing Temu products leaves Amazon products intact
    await clearAllTemuProducts();
    expect(await getTemuProductsBySession(temuSessionId)).toHaveLength(0);
    expect(await db.products.count()).toBe(1);

    // Updating Temu settings leaves Amazon settings table untouched
    await updateTemuSettings({ defaultTargetCount: 250 });
    const temuSettings = await getTemuSettings();
    expect(temuSettings.defaultTargetCount).toBe(250);
    expect(await db.settings.count()).toBe(0);

    const temuSessionRow = await getTemuSession(temuSessionId);
    expect(temuSessionRow?.sessionId).toBe(temuSessionId);
    expect(await db.history.count()).toBe(0);
  });

  it('isolates active session recovery keys in browser.storage.session (pphunt.activeSession vs pphunt.temu.activeSession)', async () => {
    sessionStorageMap['pphunt.activeSession'] = {
      sessionKey: 'amazon-active-1',
      status: 'collecting',
      collectedCount: 15,
    };

    await writeActiveTemuSession({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      tabId: 402,
      mode: 'automatic',
      targetCount: 100,
      lastCollectedCount: 30,
      url: 'https://www.temu.com/womens-shoes-o3-95.html',
      pageType: 'category',
      searchQuery: 'womens shoes',
      startedAt: '2026-10-17T11:00:00.000Z',
    });

    expect(sessionStorageMap[TEMU_ACTIVE_SESSION_KEY]).toBeDefined();
    expect(sessionStorageMap['pphunt.activeSession']).toEqual({
      sessionKey: 'amazon-active-1',
      status: 'collecting',
      collectedCount: 15,
    });

    const loadedTemu = await readActiveTemuSession();
    expect(loadedTemu?.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(loadedTemu?.lastCollectedCount).toBe(30);

    // Clearing Temu active session does not touch Amazon active session
    await clearActiveTemuSession();
    expect(await readActiveTemuSession()).toBeNull();
    expect(sessionStorageMap['pphunt.activeSession']).toEqual({
      sessionKey: 'amazon-active-1',
      status: 'collecting',
      collectedCount: 15,
    });
  });

  it('routes TEMU_* messages through registerTemuBackgroundHandlers and ignores Amazon messages', async () => {
    const handlers = registerTemuBackgroundHandlers();

    // Non-Temu message is ignored synchronously without invoking sendResponse
    const amazonSendResponse = vi.fn();
    const handledAmazon = handlers.handleTemuMessage(
      { type: 'START_COLLECTION', payload: { mode: 'manual', targetCount: 50 } },
      {},
      amazonSendResponse
    );
    expect(handledAmazon).toBe(false);
    expect(amazonSendResponse).not.toHaveBeenCalled();

    // Valid TEMU_START_COLLECTION acknowledges via sendResponse({ ok: true }) and creates a Temu session in PPHuntTemuDB
    const sendResponse = vi.fn();
    handlers.handleTemuMessage(
      {
        type: 'TEMU_START_COLLECTION',
        payload: {
          mode: 'manual',
          targetCount: 50,
          tabId: 301,
        },
      },
      {},
      sendResponse
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });

    await waitFor(async () => {
      const count = await temuDb.sessions.count();
      expect(count).toBeGreaterThan(0);
    });

    // Amazon database remains completely empty
    expect(await db.products.count()).toBe(0);
    expect(await db.history.count()).toBe(0);
  });

  it('auto-selects engine from active tab URL and allows manual switching via Header pill toggle without mixing store state', async () => {
    useCollectionStore.setState({
      status: 'paused',
      collectedCount: 12,
      targetCount: 50,
    });
    useTemuCollectionStore.setState({
      status: 'idle',
      collectedCount: 7,
      targetCount: 100,
    });

    // Start on a Temu tab -> App auto-selects Temu engine
    (browser.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 501,
        url: 'https://www.temu.com/search_result.html?search_key=desk+lamp',
      },
    ]);

    render(createElement(App));

    const amazonToggle = screen.getByTestId('engine-toggle-amazon');
    const temuToggle = screen.getByTestId('engine-toggle-temu');

    await waitFor(() => {
      expect(temuToggle.getAttribute('aria-pressed')).toBe('true');
      expect(amazonToggle.getAttribute('aria-pressed')).toBe('false');
    });

    // Manually switch to Amazon via Header pill toggle
    fireEvent.click(amazonToggle);
    expect(amazonToggle.getAttribute('aria-pressed')).toBe('true');
    expect(temuToggle.getAttribute('aria-pressed')).toBe('false');

    // Verify neither engine's Zustand store state was reset or mixed by switching
    expect(useCollectionStore.getState().collectedCount).toBe(12);
    expect(useCollectionStore.getState().status).toBe('paused');
    expect(useTemuCollectionStore.getState().collectedCount).toBe(7);
    expect(useTemuCollectionStore.getState().targetCount).toBe(100);
  });

  it('sanitizes spreadsheet formula injection in Temu CSV and Clipboard TSV exports', () => {
    const products = [
      {
        goodsId: '601099769178067',
        asin: '601099769178067',
        title: "=CMD|' /C calc'!A0 Malicious Title",
        price: 14.99,
        listPrice: 29.99,
        discountPercentage: '50% off',
        currency: 'USD',
        rating: 4.9,
        reviewCount: 512,
        pastMonthSales: '5K+ sold',
        badge: null,
        dealBadge: null,
        bestSellersRank: null,
        coupon: null,
        delivery: 'Free shipping',
        imageUrl: null,
        url: 'https://www.temu.com/goods.html?goods_id=601099769178067',
        isSponsored: false,
        isPrime: false,
        brand: '+MaliciousBrand',
        availability: 'In Stock',
        seller: '@MaliciousSeller',
        description: null,
        features: [],
        collectedAt: '2026-10-17T12:00:00.000Z',
        source: 'search' as const,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    ];

    const csv = buildTemuCSVContent(products, [
      'asin',
      'title',
      'brand',
      'seller',
    ]);
    expect(csv).toContain('601099769178067');
    expect(csv).toContain("'=CMD|");
    expect(csv).toContain("'+MaliciousBrand");
    expect(csv).toContain("'@MaliciousSeller");

    const tsv = buildTemuClipboardTSV(products, [
      'asin',
      'title',
      'brand',
      'seller',
    ]);
    expect(tsv).toContain("'=CMD|");
    expect(tsv).toContain("'+MaliciousBrand");
  });

  it('exports missing Discount/Deal/Coupon/Badge as No and other optional fields as blank in Temu CSV and clipboard (SAD-348)', () => {
    const products = [
      {
        goodsId: '601099769178068',
        asin: '601099769178068',
        title: 'Plain Product',
        price: 9.99,
        listPrice: null,
        discountPercentage: null,
        dealBadge: null,
        currency: 'USD',
        rating: 4.1,
        reviewCount: 12,
        bestSellersRank: null,
        pastMonthSales: null,
        coupon: null,
        badge: null,
        delivery: null,
        brand: null,
        seller: null,
        availability: null,
        imageUrl: null,
        url: 'https://www.temu.com/goods.html?goods_id=601099769178068',
        isSponsored: false,
        isPrime: false,
        description: null,
        features: [],
        collectedAt: '2026-10-17T12:00:00.000Z',
        source: 'search' as const,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    ];
    const cols = [
      'Price',
      'List Price',
      'Discount',
      'Deal',
      'Coupon',
      'Badge',
      'Delivery',
    ];
    const csvLines = buildTemuCSVContent(products, cols).split('\n');
    expect(csvLines[1]).toBe('9.99,,No,No,No,No,');
    const tsvLines = buildTemuClipboardTSV(products, cols).split('\n');
    expect(tsvLines[1]).toBe('9.99\t\tNo\tNo\tNo\tNo\t');
    expect(csvLines.join('\n')).not.toContain('—');
    expect(tsvLines.join('\n')).not.toContain('—');
  });
});
