import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from '@/entrypoints/sidepanel/App';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { useTemuCollectionStore } from '@/engines/temu/ui/store/collectionStore';
import { useTemuUIStore } from '@/engines/temu/ui/store/uiStore';
import { db } from '@/lib/db/database';
import { temuDb } from '@/engines/temu/db/database';
import { createAmazonBackgroundController } from '@/engines/amazon/background/handler';
import { registerTemuBackgroundHandlers } from '@/engines/temu/background/handler';

describe('Extraction & Preview Workflow Fixes (SAD-264)', () => {
  let messageListeners: Array<(msg: unknown, sender?: unknown) => void>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let currentTabUrl: string;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await temuDb.delete();
    await temuDb.open();

    useCollectionStore.getState().reset();
    useUIStore.setState({
      activeTab: 'collect',
      settingsOpen: false,
      completionDialogOpen: false,
      previewOverlayOpen: false,
      exportModalOpen: false,
      selectedSessionKey: null,
    });

    useTemuCollectionStore.getState().reset();
    useTemuUIStore.setState({
      activeTab: 'collect',
      settingsOpen: false,
      completionDialogOpen: false,
      previewOverlayOpen: false,
      exportModalOpen: false,
      selectedSessionId: null,
    });

    messageListeners = [];
    sendMessage = vi.fn().mockResolvedValue(undefined);
    currentTabUrl = 'https://www.amazon.com/dp/B08N5WRWNW';

    vi.stubGlobal('browser', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (fn: (msg: unknown, sender?: unknown) => void) => {
            messageListeners.push(fn);
          },
          removeListener: (fn: (msg: unknown, sender?: unknown) => void) => {
            messageListeners = messageListeners.filter((l) => l !== fn);
          },
        },
      },
      tabs: {
        query: vi.fn(async () => [
          {
            id: 101,
            windowId: 1,
            active: true,
            url: currentTabUrl,
          },
        ]),
        get: vi.fn(async (id: number) => ({
          id,
          windowId: 1,
          active: true,
          url: currentTabUrl,
        })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      action: {
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    await temuDb.delete();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Issue 2 (Background): serializes PRODUCTS_COLLECTED before COLLECTION_COMPLETE so completed is never overwritten by collecting', async () => {
    const controller = createAmazonBackgroundController();
    controller.handleMessage(
      {
        type: 'START_COLLECTION',
        payload: {
          mode: 'manual',
          targetCount: 50,
          tabId: 101,
          sessionKey: '101_race_test',
        },
      },
      { tab: { id: 101, url: 'https://www.amazon.com/dp/B08N5WRWNW' } },
    );

    await waitFor(async () => {
      const session = await db.sessions.get('101_race_test');
      expect(session).toBeTruthy();
    });

    sendMessage.mockClear();

    // Fire PRODUCTS_COLLECTED and COLLECTION_COMPLETE back-to-back without awaiting PRODUCTS_COLLECTED first
    controller.handleMessage(
      {
        type: 'PRODUCTS_COLLECTED',
        payload: {
          products: [
            {
              asin: 'B08N5WRWNW',
              url: 'https://www.amazon.com/dp/B08N5WRWNW',
              title: 'Single Detail Page Product',
              price: 99.99,
              currency: 'USD',
              rating: 4.8,
              reviewCount: 512,
              imageUrl: 'https://m.media-amazon.com/images/I/test.jpg',
              isSponsored: false,
              isPrime: true,
              brand: 'Keychron',
              availability: 'In Stock',
              seller: 'Keychron',
              description: 'Detail description',
              features: ['Wireless'],
              source: 'product-detail',
            },
          ],
          totalCount: 1,
          isNewBatch: true,
        },
      },
      { tab: { id: 101, url: 'https://www.amazon.com/dp/B08N5WRWNW' } },
    );

    controller.handleMessage(
      {
        type: 'COLLECTION_COMPLETE',
        payload: {
          totalCollected: 1,
          reason: 'target_reached',
        },
      },
      { tab: { id: 101, url: 'https://www.amazon.com/dp/B08N5WRWNW' } },
    );

    await waitFor(() => {
      const updateProgressCalls = sendMessage.mock.calls
        .map(
          (c) =>
            c[0] as {
              type: string;
              payload: { status: string; collected: number };
            },
        )
        .filter((m) => m?.type === 'UPDATE_PROGRESS');
      expect(updateProgressCalls.length).toBeGreaterThanOrEqual(2);
      const lastBroadcast =
        updateProgressCalls[updateProgressCalls.length - 1]!;
      expect(lastBroadcast.payload.status).toBe('completed');
      expect(lastBroadcast.payload.collected).toBe(1);
    });

    const savedProducts = await db.products
      .where('sessionKey')
      .equals('101_race_test')
      .toArray();
    expect(savedProducts).toHaveLength(1);
  });

  it('Issue 2 (UI): immediately hides Pause/Stop and shows ready Start controls on completion, ignoring late collecting messages', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useCollectionStore.getState().isAmazonPage).toBe(true);
    });

    const startBtn = screen.getByRole('button', { name: /Start$/ });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(useCollectionStore.getState().status).toBe('collecting');
    });

    expect(screen.getByRole('button', { name: /Pause$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop$/ })).toBeTruthy();

    // Background broadcasts completion
    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: {
            collected: 1,
            target: 50,
            status: 'completed',
            sessionKey: useCollectionStore.getState().currentSessionKey,
          },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Extraction Complete')).toBeTruthy();
    });

    // Pause and Stop must be gone immediately even while ExtractionCompleteModal is open
    expect(screen.queryByRole('button', { name: /Pause$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Start$/ })).toBeTruthy();
    expect(useCollectionStore.getState().collectionTabId).toBeNull();

    // Simulate a late out-of-order collecting message arriving while completion dialog is open
    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: {
            collected: 1,
            target: 50,
            status: 'collecting',
          },
        });
      }
    });

    expect(useCollectionStore.getState().status).toBe('completed');
    expect(screen.queryByRole('button', { name: /Pause$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop$/ })).toBeNull();
  });

  it('Issue 1 (UI): supports Refresh/New Extraction, Collect More (Continue Session), and Preview reopening after closing Preview', async () => {
    await db.products.add({
      sessionKey: 'session-continue-1',
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      title: 'Initial Extracted Product',
      price: 79.99,
      currency: 'USD',
      rating: 4.7,
      reviewCount: 340,
      imageUrl: null,
      isSponsored: false,
      isPrime: true,
      brand: 'Keychron',
      availability: 'In Stock',
      seller: 'Keychron',
      description: null,
      features: [],
      collectedAt: new Date().toISOString(),
      source: 'detail',
    });

    render(<App />);

    await waitFor(() => {
      expect(useCollectionStore.getState().isAmazonPage).toBe(true);
    });

    // Complete extraction of 1 product with targetCount = 1
    act(() => {
      useCollectionStore.getState().setTarget(1);
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: {
            collected: 1,
            target: 1,
            status: 'completed',
            sessionKey: 'session-continue-1',
          },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Extraction Complete')).toBeTruthy();
    });

    // Click "Preview Current Extraction"
    fireEvent.click(
      screen.getByRole('button', { name: /Preview Current Extraction/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('fullwidth-preview-overlay')).toBeTruthy();
    });

    // User navigates to another Amazon product page and closes the preview overlay
    currentTabUrl = 'https://www.amazon.com/dp/B09XS7JWHH';
    fireEvent.click(
      screen.getByRole('button', { name: 'Close preview overlay' }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId('fullwidth-preview-overlay')).toBeNull();
      expect(useCollectionStore.getState().activeTabUrl).toBe(
        'https://www.amazon.com/dp/B09XS7JWHH',
      );
    });

    // On the Collect tab, user sees Start, + Collect More, Preview (1), and Refresh
    const collectMoreBtn = screen.getByRole('button', { name: 'Collect More' });
    const previewBtn = screen.getByRole('button', {
      name: 'Preview collected products',
    });
    const refreshBtn = screen.getByRole('button', {
      name: 'Refresh extraction state',
    });

    expect(collectMoreBtn).toBeTruthy();
    expect(previewBtn.textContent).toContain('Preview (1)');
    expect(refreshBtn).toBeTruthy();

    // Clicking "+ Collect More" continues the same session ('session-continue-1'), preserves collectedCount = 1, and bumps targetCount above 1
    sendMessage.mockClear();
    fireEvent.click(collectMoreBtn);

    await waitFor(() => {
      expect(useCollectionStore.getState().status).toBe('collecting');
    });
    expect(useCollectionStore.getState().collectedCount).toBe(1);
    expect(useCollectionStore.getState().currentSessionKey).toBe(
      'session-continue-1',
    );
    expect(useCollectionStore.getState().targetCount).toBeGreaterThan(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'START_COLLECTION',
        payload: expect.objectContaining({
          sessionKey: 'session-continue-1',
          tabId: 101,
        }),
      }),
    );

    // Complete second product in the same session
    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: {
            collected: 2,
            target: useCollectionStore.getState().targetCount,
            status: 'completed',
            sessionKey: 'session-continue-1',
          },
        });
      }
    });

    await waitFor(() => {
      expect(useCollectionStore.getState().status).toBe('completed');
      expect(useCollectionStore.getState().collectedCount).toBe(2);
    });

    // Click the freshly rendered "Refresh extraction state" button
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh extraction state' }),
    );

    await waitFor(() => {
      expect(useCollectionStore.getState().status).toBe('idle');
      expect(useCollectionStore.getState().collectedCount).toBe(0);
      expect(useCollectionStore.getState().currentSessionKey).toBeNull();
    });

    // Stored products in IndexedDB remain intact
    const stored = await db.products.toArray();
    expect(stored).toHaveLength(1);
  });

  it('Temu Engine (Issue 1 & Issue 2): serializes completion, immediately resets controls, and supports Collect More & Refresh', async () => {
    currentTabUrl = 'https://www.temu.com/search_result.html?search_key=shoes';
    const temuSessionId = crypto.randomUUID();
    const temuHandlers = registerTemuBackgroundHandlers();

    temuHandlers.handleTemuMessage(
      {
        type: 'TEMU_START_COLLECTION',
        payload: {
          mode: 'manual',
          targetCount: 50,
          tabId: 101,
          sessionId: temuSessionId,
        },
      },
      { tab: { id: 101, url: currentTabUrl } },
    );

    sendMessage.mockClear();

    temuHandlers.handleTemuMessage(
      {
        type: 'TEMU_PRODUCTS_COLLECTED',
        payload: {
          products: [
            {
              goodsId: '601099512345678',
              url: 'https://www.temu.com/goods.html?goods_id=601099512345678',
              title: 'Temu Running Shoes',
              price: 19.99,
              originalPrice: 39.99,
              currency: 'USD',
              discount: '-50%',
              rating: 4.8,
              reviewCount: 410,
              soldCount: '2.1K+ sold',
              soldCountNumeric: 2100,
              imageUrl: 'https://img.kwcdn.com/product/shoe.jpg',
              galleryImages: [],
              seller: 'RunnerStore',
              sellerRating: null,
              isAd: false,
              badges: [],
              freeShipping: true,
              deliveryInfo: 'Free shipping',
              stockStatus: 'In Stock',
              categoryBreadcrumb: null,
              variations: [],
              source: 'search',
              searchQuery: 'shoes',
            },
          ],
          totalOnPage: 1,
          pageType: 'search',
          pageUrl: currentTabUrl,
        },
      },
      { tab: { id: 101, url: currentTabUrl } },
    );

    temuHandlers.handleTemuMessage(
      {
        type: 'TEMU_COLLECTION_COMPLETE',
        payload: {
          totalCollected: 1,
          reason: 'target_reached',
        },
      },
      { tab: { id: 101, url: currentTabUrl } },
    );

    await waitFor(() => {
      const statusCalls = sendMessage.mock.calls
        .map(
          (c) =>
            c[0] as {
              type: string;
              payload: { status: string; collectedCount: number };
            },
        )
        .filter((m) => m?.type === 'TEMU_COLLECTION_STATUS');
      expect(statusCalls).toHaveLength(1);
      expect(statusCalls[0]!.payload.status).toBe('completed');
      expect(statusCalls[0]!.payload.collectedCount).toBe(1);
    });

    render(<App />);

    await waitFor(() => {
      expect(useTemuCollectionStore.getState().isTemuPage).toBe(true);
    });

    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'TEMU_COLLECTION_STATUS',
          payload: {
            status: 'completed',
            collectedCount: 1,
            targetCount: 50,
            sessionId: temuSessionId,
            reason: 'target_reached',
          },
        });
      }
    });

    await waitFor(() => {
      expect(useTemuCollectionStore.getState().status).toBe('completed');
    });

    // Pause and Stop must not be visible after completion
    expect(screen.queryByRole('button', { name: /Pause$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collect More' })).toBeTruthy();

    // Refresh resets progress UI to 0 / Ready while preserving stored Temu products
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh extraction state' }),
    );

    await waitFor(() => {
      expect(useTemuCollectionStore.getState().status).toBe('idle');
      expect(useTemuCollectionStore.getState().collectedCount).toBe(0);
    });

    const temuStored = await temuDb.products.toArray();
    expect(temuStored).toHaveLength(1);
  });
});
