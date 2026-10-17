/**
 * Step 4.4 (SAD-175) — M-1: the progress counter never regresses. The
 * background finally sends `existingAsins` on COLLECT_PRODUCTS, the content
 * script counts the seeds in its reported total, and the payload is bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { MAX_SEEDED_ASINS } from '@/constants/defaults';

type Listener = (msg: unknown, sender?: unknown, sr?: (r?: unknown) => void) => unknown;

// ── background side ─────────────────────────────────────────────────────────

function stubBrowserForBackground(tabsSendMessage: ReturnType<typeof vi.fn>) {
  const listeners: Listener[] = [];
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
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {
      sendMessage: tabsSendMessage,
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
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
  return listeners;
}

async function startCollectionAgainstSeededSession(productCount: number) {
  const { db } = await import('@/lib/db/database');
  const rows = Array.from({ length: productCount }, (_, i) => ({
    asin: `B0SEED${String(i).padStart(5, '0')}`,
    url: 'https://www.amazon.com/dp/x',
    collectedAt: '2026-10-17T00:00:00.000Z',
    sessionKey: '42_1000',
    source: 'search' as const,
  }));
  await db.products.bulkPut(rows);

  const tabsSendMessage = vi.fn().mockResolvedValue(undefined);
  const listeners = stubBrowserForBackground(tabsSendMessage);
  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
  await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
  for (const listener of listeners) {
    listener({
      type: 'START_COLLECTION',
      payload: { mode: 'automatic', targetCount: 500, tabId: 42, sessionKey: '42_1000' },
    });
  }
  await waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
  return tabsSendMessage;
}

beforeEach(async () => {
  vi.resetModules();
  const { db } = await import('@/lib/db/database');
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('M-1: background sends existingAsins on COLLECT_PRODUCTS', () => {
  it('carries the ASINs already stored for the session', async () => {
    const tabsSendMessage = await startCollectionAgainstSeededSession(120);

    const call = tabsSendMessage.mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'COLLECT_PRODUCTS'
    )!;
    const payload = (call[1] as { payload: { existingAsins?: string[] } }).payload;
    expect(payload.existingAsins).toHaveLength(120); // getExistingASINs finally has a caller
    expect(payload.existingAsins).toContain('B0SEED00000');
  });

  it(`bounds the payload to MAX_SEEDED_ASINS (${MAX_SEEDED_ASINS})`, async () => {
    const tabsSendMessage = await startCollectionAgainstSeededSession(
      MAX_SEEDED_ASINS + 3000
    );

    const call = tabsSendMessage.mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'COLLECT_PRODUCTS'
    )!;
    const payload = (call[1] as { payload: { existingAsins?: string[] } }).payload;
    expect(payload.existingAsins!.length).toBeLessThanOrEqual(MAX_SEEDED_ASINS);
    expect(payload.existingAsins).toHaveLength(MAX_SEEDED_ASINS);
  });
});

// ── content side ────────────────────────────────────────────────────────────

const DEALS_DOM = `
  <div data-testid="grid-deals-container">
    <div data-testid="deal-card" data-asin="B0DEAL9901">
      <a href="/Deal-Headphones/dp/B0DEAL9901"><span>Sony Deal</span></a>
      <span class="a-price"><span class="a-offscreen">$119.99</span></span>
    </div>
  </div>
`;

describe('M-1: content counts seeds in the reported total', () => {
  let contentListeners: Listener[];
  let sentMessages: Array<{ type: string; payload?: Record<string, unknown> }>;

  beforeEach(() => {
    contentListeners = [];
    sentMessages = [];
    vi.stubGlobal('browser', {
      runtime: {
        onMessage: {
          addListener: (fn: Listener) => contentListeners.push(fn),
          removeListener: vi.fn(),
        },
        sendMessage: vi.fn().mockImplementation((msg: never) => {
          sentMessages.push(msg);
          return Promise.resolve({ ok: true });
        }),
      },
    });
    vi.stubGlobal('defineContentScript', (cfg: unknown) => cfg);
    document.body.innerHTML = DEALS_DOM;
  });

  afterEach(() => {
    const win = window as unknown as { __PPHUNT_CONTENT_CLEANUP__?: () => void };
    try {
      win.__PPHUNT_CONTENT_CLEANUP__?.();
    } catch {
      // ignore
    }
    document.body.innerHTML = '';
  });

  async function dispatchCollect(existingAsins: string[], duplicateDetection = true) {
    const { default: contentScript } = await import('@/entrypoints/amazon.content');
    (contentScript as unknown as { main: () => void }).main();
    contentListeners[0]!(
      {
        type: 'COLLECT_PRODUCTS',
        payload: {
          mode: 'manual',
          targetCount: 50,
          scroll: {
            scrollAmount: 800,
            scrollInterval: 500,
            waitAfterScroll: 1500,
            duplicateDetection,
          },
          existingAsins,
        },
      },
      {},
      vi.fn()
    );
  }

  it('reports seeds + newly parsed, and never double-counts a seeded ASIN on the page', async () => {
    // B0DEAL9901 is on the page AND in the seeds: it must count once.
    await dispatchCollect(['B0DEAL9901', 'B0SEED00001', 'B0SEED00002']);

    await waitFor(() =>
      expect(
        sentMessages.some(
          (m) => m.type === 'COLLECTION_PROGRESS' && m.payload?.collected === 3
        )
      ).toBe(true)
    );
    // fails before Step 4.4: collected was collectedProducts.length only (0 —
    // the seeded page ASIN was filtered by dedup)
  });

  it('with duplicateDetection off, seeds are neither filtered nor counted', async () => {
    await dispatchCollect(['B0DEAL9901', 'B0SEED00001'], false);

    await waitFor(() =>
      expect(
        sentMessages.some(
          (m) => m.type === 'COLLECTION_PROGRESS' && m.payload?.collected === 1
        )
      ).toBe(true)
    ); // just the page's product — no phantom seed inflation
  });
});
