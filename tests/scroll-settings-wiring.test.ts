/**
 * Step 3.4 (SAD-170) — H-1b: the persisted scroll settings reach the content
 * script's ScrollController, duplicateDetection gates the dedup engine at the
 * consultation sites, and the background forwards the config on
 * COLLECT_PRODUCTS. Defaults must match the pre-wiring hardcoded numbers
 * exactly (Step 3.0 snapshot).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const { scrollCtorSpy } = vi.hoisted(() => ({ scrollCtorSpy: vi.fn() }));

vi.mock('@/lib/scraper/scroll-controller', () => {
  class MockScrollController {
    isRunning = false;
    isPaused = false;
    constructor(config: unknown) {
      scrollCtorSpy(config);
    }
    start(): void {
      this.isRunning = true;
    }
    stop(): void {
      this.isRunning = false;
    }
    pause(): void {
      this.isPaused = true;
    }
  }
  return { ScrollController: MockScrollController };
});

const DEALS_DOM = `
  <div data-testid="grid-deals-container">
    <div data-testid="deal-card" data-asin="B0DEAL9901">
      <a href="/Deal-Headphones/dp/B0DEAL9901">
        <span>Sony Wireless Deal Headphones</span>
      </a>
      <span data-a-badge-type="deal"><span class="a-badge-text">Limited-time deal</span></span>
      <span class="savingsPercentage">-40%</span>
      <span class="a-price" data-a-strike="true"><span class="a-offscreen">$199.99</span></span>
      <span class="a-price"><span class="a-offscreen">$119.99</span></span>
      <img src="https://m.media-amazon.com/images/I/71sonydeal._AC_SL1000_.jpg" alt="Sony Deal" />
    </div>
  </div>
`;

type ContentListener = (msg: unknown, sender?: unknown, sr?: (r?: unknown) => void) => unknown;

let contentListeners: ContentListener[];
let sentMessages: Array<{ type: string; payload?: Record<string, unknown> }>;

async function startContentScript() {
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: ContentListener) => contentListeners.push(fn),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn().mockImplementation((msg: never) => {
        sentMessages.push(msg);
        return Promise.resolve({ ok: true });
      }),
    },
  });
  vi.stubGlobal('defineContentScript', (cfg: unknown) => cfg);
  const { default: contentScript } = await import('@/entrypoints/amazon.content');
  (contentScript as unknown as { main: () => void }).main();
  expect(contentListeners.length).toBeGreaterThan(0);
}

function dispatch(message: unknown): unknown {
  const sr = vi.fn();
  const result = contentListeners[0]!(message, {}, sr);
  return result;
}

beforeEach(async () => {
  vi.resetModules();
  contentListeners = [];
  sentMessages = [];
  scrollCtorSpy.mockClear();
  document.body.innerHTML = '';
  const { db } = await import('@/lib/db/database');
  await db.delete();
  await db.open();
});

afterEach(async () => {
  // Tear down the previous content-script instance (stops its observer and
  // listener) via the content script's own cleanup hook — deleting the hook
  // instead would let stale observers leak into the next test.
  const win = window as unknown as { __PPHUNT_CONTENT_CLEANUP__?: () => void };
  try {
    win.__PPHUNT_CONTENT_CLEANUP__?.();
  } catch {
    // ignore — cleanup against an already-torn-down stub
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('H-1b: ScrollController receives the configured values', () => {
  it('passes scrollAmount/scrollInterval/waitAfterScroll from the message', async () => {
    document.body.innerHTML = DEALS_DOM;
    await startContentScript();

    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: {
        mode: 'automatic',
        targetCount: 5,
        scroll: {
          scrollAmount: 1200,
          scrollInterval: 2000,
          waitAfterScroll: 3000,
          duplicateDetection: true,
        },
      },
    });

    expect(scrollCtorSpy).toHaveBeenCalledWith({
      scrollAmount: 1200,
      scrollInterval: 2000,
      waitAfterScroll: 3000,
      maxWaitForNew: 5000,
      maxLoadingWait: 15000,
    });
  });

  it('no scroll key -> the exact pre-wiring hardcoded defaults (800/500/1500)', async () => {
    document.body.innerHTML = DEALS_DOM;
    await startContentScript();

    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'automatic', targetCount: 5 },
    });

    expect(scrollCtorSpy).toHaveBeenCalledWith({
      scrollAmount: 800,
      scrollInterval: 500,
      waitAfterScroll: 1500,
      maxWaitForNew: 5000,
      maxLoadingWait: 15000,
    });
  });
});

describe('H-1b: duplicateDetection gates the dedup engine', () => {
  // Note: every COLLECT_PRODUCTS dispatch calls dedup.clear(), so the gate is
  // exercised WITHIN a run: the manual-mode MutationObserver re-parses the
  // page after a DOM change and consults the engine.

  async function collectThenMutate(scroll?: Record<string, unknown>) {
    document.body.innerHTML = DEALS_DOM;
    await startContentScript();
    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: {
        mode: 'manual',
        targetCount: 50,
        ...(scroll ? { scroll } : {}),
      },
    });
    await waitFor(() =>
      expect(sentMessages.filter((m) => m.type === 'PRODUCTS_COLLECTED')).toHaveLength(1)
    );
    // trigger the MutationObserver -> debounced re-parse of the same DOM
    document.body.appendChild(document.createElement('div'));
  }

  const collectedCount = () =>
    sentMessages.filter((m) => m.type === 'PRODUCTS_COLLECTED').length;

  it('duplicateDetection:false -> the observer re-parse is NOT filtered', async () => {
    await collectThenMutate({
      scrollAmount: 800,
      scrollInterval: 500,
      waitAfterScroll: 1500,
      duplicateDetection: false,
    });

    await waitFor(() => expect(collectedCount()).toBe(2), { timeout: 2500 });
    const last = sentMessages.filter((m) => m.type === 'PRODUCTS_COLLECTED')[1]!;
    expect((last.payload!.products as unknown[]).length).toBe(1); // not dropped
  });

  it('duplicateDetection:true (default) -> the observer re-parse IS filtered (unchanged behaviour)', async () => {
    await collectThenMutate(); // no scroll key -> duplicateDetection defaults to true

    // wait past the 300 ms observer debounce; no second message may appear
    await new Promise((r) => setTimeout(r, 700));
    expect(collectedCount()).toBe(1);
  });
});

describe('H-1b: background forwards the persisted scroll settings', () => {
  function stubBrowserForBackground(tabsSendMessage: ReturnType<typeof vi.fn>) {
    const onMessageListeners: ContentListener[] = [];
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
        local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
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
          addListener: (fn: ContentListener) => onMessageListeners.push(fn),
          removeListener: vi.fn(),
        },
        sendMessage: vi.fn().mockResolvedValue(undefined),
        getURL: vi.fn().mockReturnValue('chrome-extension://x/overlay.html'),
      },
      scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
    });
    vi.stubGlobal('defineBackground', (main: () => void) => main);
    return onMessageListeners;
  }

  async function startCollectionWithSettings(settings: Record<string, unknown> | null) {
    const { db } = await import('@/lib/db/database');
    const { SettingsSchema } = await import('@/lib/schemas/settings');
    if (settings) {
      await db.settings.put(SettingsSchema.parse(settings) as never);
    }
    const tabsSendMessage = vi.fn().mockResolvedValue(undefined);
    const listeners = stubBrowserForBackground(tabsSendMessage);
    const { default: main } = await import('@/entrypoints/background');
    (main as unknown as () => void)();
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));

    for (const listener of listeners) {
      listener({
        type: 'START_COLLECTION',
        payload: { mode: 'automatic', targetCount: 50, tabId: 42 },
      });
    }
    await waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
    return tabsSendMessage;
  }

  it('forwards configured values as the scroll payload', async () => {
    const tabsSendMessage = await startCollectionWithSettings({
      scrollSpeed: 1200,
      scrollInterval: 2000,
      waitAfterScroll: 3000,
      duplicateDetection: false,
    });

    expect(tabsSendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: 'COLLECT_PRODUCTS',
        payload: expect.objectContaining({
          mode: 'automatic',
          targetCount: 50,
          scroll: {
            scrollAmount: 1200,
            scrollInterval: 2000,
            waitAfterScroll: 3000,
            duplicateDetection: false,
          },
        }),
      })
    );
  });

  it('with no settings row, forwards the schema defaults (identical to today)', async () => {
    const tabsSendMessage = await startCollectionWithSettings(null);

    expect(tabsSendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: 'COLLECT_PRODUCTS',
        payload: expect.objectContaining({
          scroll: {
            scrollAmount: 800,
            scrollInterval: 500,
            waitAfterScroll: 1500,
            duplicateDetection: true,
          },
        }),
      })
    );
  });
});
