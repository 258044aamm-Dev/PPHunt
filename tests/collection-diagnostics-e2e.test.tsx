/**
 * SAD-369 step 3 (T23–T26, T28, T29) — the collection path end-to-end
 * through the real `amazon.content.ts`.
 *
 * - a collection of N ≤ 50 cards ships N per-product reports on
 *   PRODUCTS_COLLECTED, and the drift line rides DRIFT_REPORT to the worker
 *   instead of the page console (D10);
 * - a collection of 60 ships exactly 50 (D7) — the 51st is not reported;
 * - a second run resets the cap (T26);
 * - the switch off ships nothing;
 * - a collection started on a product page reports once (G10);
 * - the cap never applies to a save (D8/T29).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const { cardLayerSpy } = vi.hoisted(() => ({ cardLayerSpy: vi.fn() }));

vi.mock('@/engines/amazon/content/card-action-layer', () => ({
  createCardActionLayer: cardLayerSpy,
}));

vi.mock('@/engines/amazon/content/card-action-theme', () => ({
  syncCardActionTheme: vi.fn(() => vi.fn()),
}));

type SentMessage = { type: string; payload?: Record<string, unknown> };
type Listener = (msg: any, sender?: any, sr?: (r?: unknown) => void) => unknown;

let storageState: Record<string, unknown>;
let sentMessages: SentMessage[];
let listeners: Listener[];

function searchResultsDom(count: number): string {
  const cards = Array.from({ length: count }, (_, i) => {
    const asin = `B0CARD${String(i + 1).padStart(4, '0')}`;
    return `
      <div data-component-type="s-search-result" data-asin="${asin}">
        <h2><a href="/Widget-${i + 1}/dp/${asin}"><span>Widget ${i + 1}</span></a></h2>
        <img class="s-image" src="https://m.media-amazon.com/images/I/w${i + 1}.jpg">
        <span class="a-price"><span class="a-offscreen">$${(10 + i).toFixed(2)}</span></span>
      </div>`;
  }).join('');
  return `<div class="s-main-slot">${cards}</div>`;
}

const DETAIL_DOM = `
  <span id="productTitle">Delta Widget, 2 Pack</span>
  <div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-price-whole">89</span><span class="a-price-fraction">99</span></span>
  </div>
  <span id="acrCustomerReviewText">1,204 ratings</span>
  <i id="acrPopover" title="4.5 out of 5 stars"></i>
  <img id="landingImage" src="https://m.media-amazon.com/images/I/delta._AC_SL1500_.jpg">
  <div id="feature-bullets"><ul><li>Solid brass</li><li>Two pack</li></ul></div>
  <span id="bylineInfo">Visit the Delta Store</span>
  <div id="availability"><span>In Stock</span></div>
`;

async function startContentScript(): Promise<void> {
  const { default: contentScript } = await import(
    '@/entrypoints/amazon.content'
  );
  (contentScript as unknown as { main: () => void }).main();
  await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
}

function dispatch(message: unknown): void {
  listeners[0]!(message, {}, vi.fn());
}

function collectedMessages(): Array<{ payload: Record<string, any> }> {
  return sentMessages.filter(
    (m): m is { type: string; payload: Record<string, any> } =>
      m.type === 'PRODUCTS_COLLECTED',
  );
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

  storageState = { pphuntDiagnosticsEnabled: true };
  sentMessages = [];
  listeners = [];
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: Listener) => listeners.push(fn),
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
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
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

describe('SAD-369 step 3: collection diagnostics end-to-end', () => {
  it('T23: a collection of 10 cards ships 10 per-product reports, and the drift line rides DRIFT_REPORT', async () => {
    document.body.innerHTML = searchResultsDom(10);
    await startContentScript();

    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 100 },
    });

    await waitFor(() => expect(collectedMessages()).toHaveLength(1));
    const payload = collectedMessages()[0]!.payload;
    expect(payload.products).toHaveLength(10);

    const reports = payload.extractionDiagnostics as Array<{
      asin: string | null;
      fields: unknown[];
    }>;
    expect(reports).toHaveLength(10);
    for (const report of reports) {
      expect(report.fields).toHaveLength(26);
    }
    // Reports belong to THIS run's products, in batch order.
    const productAsins = (payload.products as Array<{ asin: string }>).map(
      (p) => p.asin,
    );
    expect(reports.map((r) => r.asin)).toEqual(productAsins);

    // D10: the drift line went to the worker as a message...
    const drift = sentMessages.filter((m) => m.type === 'DRIFT_REPORT');
    expect(drift.length).toBeGreaterThanOrEqual(1);
    expect(drift[0]!.payload).toMatchObject({ stage: 'search-results' });
  });

  it('T24/T25: a collection of 60 cards ships exactly 50 reports — the 51st product is not reported', async () => {
    document.body.innerHTML = searchResultsDom(60);
    await startContentScript();

    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 100 },
    });

    await waitFor(() => expect(collectedMessages()).toHaveLength(1));
    const payload = collectedMessages()[0]!.payload;
    expect(payload.products).toHaveLength(60);

    const reports = payload.extractionDiagnostics as Array<{
      asin: string | null;
    }>;
    expect(reports).toHaveLength(50);
    // The first 50 in scrape order, and NOT the 51st.
    expect(reports[0]!.asin).toBe('B0CARD0001');
    expect(reports[49]!.asin).toBe('B0CARD0050');
    expect(reports.some((r) => r.asin === 'B0CARD0051')).toBe(false);
  });

  it('T26: a second collection run resets the cap and reports its products again', async () => {
    document.body.innerHTML = searchResultsDom(10);
    await startContentScript();

    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 100 },
    });
    await waitFor(() => expect(collectedMessages()).toHaveLength(1));

    // Same page, same cards: a NEW run must reset the sent-set and the cap —
    // without the reset this batch would carry zero reports.
    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 100 },
    });
    await waitFor(() => expect(collectedMessages()).toHaveLength(2));

    const second = collectedMessages()[1]!.payload;
    const reports = second.extractionDiagnostics as unknown[];
    expect(reports).toHaveLength(10);
  });

  it('ships no reports and no drift message while the switch is off', async () => {
    storageState = {};
    document.body.innerHTML = searchResultsDom(10);
    await startContentScript();

    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 100 },
    });

    await waitFor(() => expect(collectedMessages()).toHaveLength(1));
    const payload = collectedMessages()[0]!.payload;
    // The collection itself is completely unaffected by the switch...
    expect(payload.products).toHaveLength(10);
    // ...and nothing diagnostic rides along.
    expect(payload.extractionDiagnostics).toBeUndefined();
    expect(sentMessages.filter((m) => m.type === 'DRIFT_REPORT')).toHaveLength(
      0,
    );
  });

  it('T28/G10: a collection started on a product page ships one report', async () => {
    // detectAmazonPageType is URL-driven, so the page identity comes from
    // location — the DOM is the PDP fixture the detail parser understands.
    vi.stubGlobal('location', {
      href: 'https://www.amazon.com/Delta-Widget/dp/B0DDDDDDDD',
    });
    document.body.innerHTML = DETAIL_DOM;
    await startContentScript();

    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 100 },
    });

    await waitFor(() => expect(collectedMessages()).toHaveLength(1));
    const payload = collectedMessages()[0]!.payload;
    expect(payload.products).toHaveLength(1);

    const reports = payload.extractionDiagnostics as Array<{
      asin: string | null;
      fields: unknown[];
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]!.asin).toBe('B0DDDDDDDD');
    expect(reports[0]!.fields).toHaveLength(25); // PDP detail report: 25 since SAD-391 (cards are 26: + badge since SAD-393)
  });

  it('T29/D8: the cap never applies to a save — a right-click after a capped run still carries its report', async () => {
    document.body.innerHTML = searchResultsDom(60);
    await startContentScript();

    // Burn the whole cap in a collection run.
    dispatch({
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 100 },
    });
    await waitFor(() => expect(collectedMessages()).toHaveLength(1));
    const reports = collectedMessages()[0]!.payload
      .extractionDiagnostics as unknown[];
    expect(reports).toHaveLength(50);

    // Now save the 55th card — past the cap — via the right-click path.
    const card = document.querySelectorAll(
      '[data-component-type="s-search-result"]',
    )[54]!;
    card
      .querySelector('.a-offscreen')!
      .dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    dispatch({
      type: 'SAVE_CONTEXT_PRODUCT',
      payload: { requestedAt: new Date().toISOString() },
    });

    await waitFor(() =>
      expect(
        sentMessages.filter((m) => m.type === 'SAVE_PRODUCT'),
      ).toHaveLength(1),
    );
    const save = sentMessages.find((m) => m.type === 'SAVE_PRODUCT')!;
    const saveReport = save.payload!.extractionDiagnostics as
      | { asin: string | null; fields: unknown[] }
      | undefined;
    expect(saveReport?.asin).toBe('B0CARD0055');
    expect(saveReport?.fields).toHaveLength(26);
  });
});
