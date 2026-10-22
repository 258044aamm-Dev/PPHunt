/**
 * SAD-369 step 2 (T20) — the card-icon save path carries the per-card report.
 *
 * Drives the real `amazon.content.ts` entrypoint with the card-action layer
 * mocked so the test can invoke the layer's `onSave` directly — the same
 * callback the on-page save button calls. With the switch on the SAVE_PRODUCT
 * payload carries `extractionDiagnostics`; with the switch off it does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cardLayerSpy } = vi.hoisted(() => ({ cardLayerSpy: vi.fn() }));

vi.mock('@/engines/amazon/content/card-action-layer', () => ({
  createCardActionLayer: cardLayerSpy,
}));

vi.mock('@/engines/amazon/content/card-action-theme', () => ({
  syncCardActionTheme: vi.fn(() => vi.fn()),
}));

const SEARCH_CARD = `
  <div data-component-type="s-search-result" data-asin="B0ICONDIAG">
    <h2><a href="/Icon-Widget/dp/B0ICONDIAG"><span>Icon Widget</span></a></h2>
    <img class="s-image" src="https://m.media-amazon.com/images/I/icon.jpg" alt="Icon Widget">
    <span class="a-price"><span class="a-offscreen">$14.99</span></span>
  </div>`;

type SaveRequest = { card: Element; asin: string; jobId: string };

let storageState: Record<string, unknown>;
let sentMessages: Array<{ type: string; payload?: Record<string, unknown> }>;

async function startContentScriptAndGetOnSave(): Promise<
  (request: SaveRequest) => Promise<void>
> {
  const { default: contentScript } = await import(
    '@/entrypoints/amazon.content'
  );
  (contentScript as unknown as { main: () => void }).main();

  expect(cardLayerSpy).toHaveBeenCalled();
  const options = cardLayerSpy.mock.calls.at(-1)![0] as {
    onSave: (request: SaveRequest) => Promise<void>;
  };
  return options.onSave;
}

beforeEach(async () => {
  vi.resetModules();
  cardLayerSpy.mockReset();
  cardLayerSpy.mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    setTheme: vi.fn(),
    mountCard: vi.fn(() => null),
    applyJobUpdate: vi.fn(() => true),
    getButton: vi.fn(() => null),
    getState: vi.fn(() => null),
  }));

  storageState = {};
  sentMessages = [];
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn((msg: never) => {
        sentMessages.push(msg);
        return Promise.resolve({ ok: true });
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ ...storageState })),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
  vi.stubGlobal('defineContentScript', (cfg: unknown) => cfg);
  document.body.innerHTML = '';
});

afterEach(() => {
  const win = window as unknown as {
    __PPHUNT_CONTENT_CLEANUP__?: () => void;
  };
  try {
    win.__PPHUNT_CONTENT_CLEANUP__?.();
  } catch {
    // ignore — cleanup against an already-torn-down stub
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SAD-369 step 2: the card-icon save path', () => {
  it('attaches the per-card report to SAVE_PRODUCT when the switch is on', async () => {
    storageState = { pphuntDiagnosticsEnabled: true };
    document.body.innerHTML = SEARCH_CARD;
    const card = document.body.querySelector('[data-asin]')!;

    const onSave = await startContentScriptAndGetOnSave();
    await onSave({ card, asin: 'B0ICONDIAG', jobId: 'job-icon-on' });

    const saveMsg = sentMessages.find((m) => m.type === 'SAVE_PRODUCT');
    expect(saveMsg).toBeTruthy();
    expect(saveMsg!.payload?.product).toMatchObject({ asin: 'B0ICONDIAG' });

    const report = saveMsg!.payload?.extractionDiagnostics as
      | { asin: string | null; fields: unknown[] }
      | undefined;
    expect(report?.asin).toBe('B0ICONDIAG');
    expect(report?.fields).toHaveLength(26);
  });

  it('sends no diagnostics with the switch off (the default)', async () => {
    // storageState stays empty: a fresh install logs nothing (D1).
    document.body.innerHTML = SEARCH_CARD;
    const card = document.body.querySelector('[data-asin]')!;

    const onSave = await startContentScriptAndGetOnSave();
    await onSave({ card, asin: 'B0ICONDIAG', jobId: 'job-icon-off' });

    const saveMsg = sentMessages.find((m) => m.type === 'SAVE_PRODUCT');
    expect(saveMsg).toBeTruthy();
    expect(saveMsg!.payload?.product).toMatchObject({ asin: 'B0ICONDIAG' });
    expect(saveMsg!.payload?.extractionDiagnostics).toBeUndefined();
  });
});
