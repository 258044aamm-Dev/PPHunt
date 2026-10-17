/**
 * Step 4.2 (SAD-173) — H-8: the background survives MV3 service-worker
 * termination. After a simulated restart, products land under the ORIGINAL
 * sessionKey, History is not fabricated, tabs.onRemoved still matches the
 * collection tab, and environments without chrome.storage.session degrade
 * gracefully to the IndexedDB path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  readActiveSession,
  writeActiveSession,
  clearActiveSession,
} from '@/lib/db/session-state';

type Listener = (msg: unknown, sender?: unknown, sr?: (r?: unknown) => void) => unknown;

function makeSessionStore() {
  const map = new Map<string, unknown>();
  return {
    map,
    api: {
      get: vi.fn(async (k: string) => (map.has(k) ? { [k]: map.get(k) } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) map.set(k, v);
      }),
      remove: vi.fn(async (k: string) => {
        map.delete(k);
      }),
    },
  };
}

interface Harness {
  listeners: Listener[];
  onRemovedListeners: Array<(tabId: number) => void>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
}

function stubBrowser(sessionApi?: ReturnType<typeof makeSessionStore>['api']): Harness {
  const listeners: Listener[] = [];
  const onRemovedListeners: Array<(tabId: number) => void> = [];
  const tabsSendMessage = vi.fn().mockResolvedValue(undefined);
  const storage: Record<string, unknown> = {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: vi.fn() },
  };
  if (sessionApi) storage.session = sessionApi;
  vi.stubGlobal('browser', {
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setPopup: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      onClicked: { addListener: vi.fn() },
    },
    storage,
    tabs: {
      sendMessage: tabsSendMessage,
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => onRemovedListeners.push(fn),
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: Listener) => listeners.push(fn),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getURL: vi.fn().mockReturnValue('chrome-extension://x/overlay.html'),
    },
    scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
  });
  vi.stubGlobal('defineBackground', (main: () => void) => main);
  return { listeners, onRemovedListeners, tabsSendMessage };
}

async function startWorker(): Promise<Harness> {
  const harness = stubBrowser(currentSessionApi);
  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
  await waitFor(() => expect(harness.listeners.length).toBeGreaterThan(0));
  return harness;
}

function dispatch(harness: Harness, message: unknown) {
  for (const listener of harness.listeners) {
    listener(message, { tab: { id: 42, url: 'https://www.amazon.com/s?k=x' } });
  }
}

const PRODUCT = {
  asin: 'B08N5WRWNW',
  title: 'Anker Charger',
  url: 'https://www.amazon.de/dp/B08N5WRWNW',
  price: 39.99,
  currency: 'EUR',
  imageUrl: 'https://m.media-amazon.com/images/I/anker.jpg',
  rating: 4.7,
  reviewCount: 1234,
  source: 'search' as const,
};

let currentSessionApi: ReturnType<typeof makeSessionStore>['api'] | undefined;

beforeEach(async () => {
  vi.resetModules();
  const { db } = await import('@/lib/db/database');
  await db.delete();
  await db.open();
});

afterEach(() => {
  currentSessionApi = undefined;
  vi.unstubAllGlobals();
});

describe('H-8: worker-restart survival via storage.session', () => {
  it('products land under the ORIGINAL sessionKey after a simulated termination', async () => {
    const store = makeSessionStore();
    currentSessionApi = store.api;

    // ── worker instance 1: START_COLLECTION with an explicit key
    const h1 = await startWorker();
    dispatch(h1, {
      type: 'START_COLLECTION',
      payload: { mode: 'automatic', targetCount: 100, tabId: 42, sessionKey: '42_1000' },
    });
    await waitFor(() => expect(store.map.has('pphunt.activeSession')).toBe(true));
    const pointer = store.map.get('pphunt.activeSession') as {
      startedAt: string;
      sessionKey: string;
      mode: string;
      targetCount: number;
    };
    expect(pointer.sessionKey).toBe('42_1000');
    expect(pointer.startedAt).toBeTruthy();

    // ── simulate MV3 termination: fresh module registry, fresh listeners,
    //    but the SAME storage.session backing map
    vi.resetModules();
    const h2 = await startWorker();

    dispatch(h2, {
      type: 'PRODUCTS_COLLECTED',
      payload: { products: [PRODUCT], totalCount: 1, isNewBatch: true },
    });

    const { db } = await import('@/lib/db/database');
    await waitFor(async () => expect(await db.products.count()).toBe(1));
    const products = await db.products.toArray();
    // fails before Step 4.2: a NEW key in a different format was minted
    expect(products[0]!.sessionKey).toBe('42_1000');

    // ── completion → History carries the ORIGINAL startedAt/mode/target, not fallbacks
    dispatch(h2, {
      type: 'COLLECTION_PROGRESS',
      payload: { collected: 1, target: 100, status: 'completed' },
    });
    await waitFor(async () => expect(await db.history.count()).toBe(1));
    const [entry] = await db.history.toArray();
    expect(entry!.sessionKey).toBe('42_1000');
    expect(entry!.startedAt).toBe(pointer.startedAt); // not the completion time
    expect(entry!.mode).toBe('automatic'); // not the 'manual' fallback
    expect(entry!.targetCount).toBe(100); // not the 50 fallback
  });

  it('tabs.onRemoved after a restart still matches the collection tab → interrupted', async () => {
    const store = makeSessionStore();
    currentSessionApi = store.api;

    const h1 = await startWorker();
    dispatch(h1, {
      type: 'START_COLLECTION',
      payload: { mode: 'manual', targetCount: 50, tabId: 42, sessionKey: '42_2000' },
    });
    await waitFor(() => expect(store.map.has('pphunt.activeSession')).toBe(true));

    vi.resetModules();
    const h2 = await startWorker();

    // fires before any message — exercises hydration from the event listener
    for (const fn of h2.onRemovedListeners) fn(42);

    const { db } = await import('@/lib/db/database');
    await waitFor(async () => {
      const row = await db.sessions.get('42_2000');
      expect(row?.status).toBe('interrupted');
    });
  });

  it('no storage.session (Firefox/older Chrome) → graceful IndexedDB fallback', async () => {
    currentSessionApi = undefined; // no storage.session in the stub

    // seed an active session row directly (browser restart, not worker restart)
    const { db } = await import('@/lib/db/database');
    const { createSession } = await import('@/lib/db/sessions');
    const key = await createSession(42, 'https://www.amazon.com/s?k=fb', 'automatic', 100);

    const h = await startWorker();
    dispatch(h, {
      type: 'PRODUCTS_COLLECTED',
      payload: { products: [PRODUCT], totalCount: 1, isNewBatch: true },
    });

    await waitFor(async () => expect(await db.products.count()).toBe(1));
    const products = await db.products.toArray();
    expect(products[0]!.sessionKey).toBe(key); // recovered from the session row
  });
});

describe('H-8: session-state pointer round-trip', () => {
  it('write → read returns the same pointer; clear removes it; garbage is rejected', async () => {
    const store = makeSessionStore();
    vi.stubGlobal('browser', { storage: { session: store.api } });

    const pointer = {
      tabId: 42,
      sessionKey: '42_3000',
      mode: 'automatic' as const,
      targetCount: 250,
      startedAt: '2026-10-17T08:00:00.000Z',
      url: 'https://www.amazon.com/s?k=rt',
      lastCollectedCount: 17,
    };
    await writeActiveSession(pointer);
    expect(await readActiveSession()).toEqual(pointer);

    await clearActiveSession();
    expect(await readActiveSession()).toBeNull();

    store.map.set('pphunt.activeSession', { nonsense: true });
    expect(await readActiveSession()).toBeNull(); // shape guard
  });
});
