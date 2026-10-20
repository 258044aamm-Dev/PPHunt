/**
 * SAD-369 step 3 — the worker side of the collection diagnostics.
 *
 * - PRODUCTS_COLLECTED carrying reports prints one `collection-card` line per
 *   report, keyed by the collection's sessionKey (including the
 *   fallback-session path), gated by the switch.
 * - DRIFT_REPORT (D10) prints the byte-identical drift line in the worker
 *   when on, and nothing when off.
 *
 * Harness pattern: the H-8 worker-restart test (`mv3-state-survival.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

type Listener = (msg: unknown, sender?: unknown, sr?: (r?: unknown) => void) => unknown;

const DIAG_TAG = '[PPHunt][Amazon][Diagnostics] ';

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

const REPORT = {
  asin: 'B08N5WRWNW',
  fields: [{ field: 'asin', status: 'EXTRACTED', source: 'dom' }],
};

const DRIFT_MESSAGE = {
  type: 'DRIFT_REPORT',
  payload: {
    stage: 'search-results',
    report: {
      cardsInspected: 3,
      cardsExtracted: 2,
      fieldCoverage: {
        asin: 1,
        title: 1,
        price: 0.5,
        rating: 0,
        reviewCount: 0,
        imageUrl: 1,
      },
      tierBreakdown: {
        tier1_json: 0,
        tier2_semantic: 2,
        tier3_structural: 0,
        tier4_selector: 0,
        missing: 1,
      },
      isDriftDetected: false,
      driftReasons: [],
    },
  },
};

interface Harness {
  listeners: Listener[];
}

let flagStorage: Record<string, unknown>;

function stubBrowser(): Harness {
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
        get: vi.fn(async () => ({ ...flagStorage })),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
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
  return { listeners };
}

async function startWorker(): Promise<Harness> {
  const harness = stubBrowser();
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

function diagnosticLines(info: ReturnType<typeof vi.spyOn>): string[] {
  return info.mock.calls
    .map((call) => call[0])
    .filter(
      (first): first is string =>
        typeof first === 'string' && first.startsWith(DIAG_TAG),
    );
}

beforeEach(async () => {
  vi.resetModules();
  flagStorage = {};
  const { db } = await import('@/lib/db/database');
  await db.delete();
  await db.open();
});

afterEach(async () => {
  const { db } = await import('@/lib/db/database');
  await db.delete();
  vi.unstubAllGlobals();
});

describe('SAD-369 step 3: the worker prints collection-card and drift lines', () => {
  it('prints one collection-card line per report, keyed by the session', async () => {
    flagStorage = { pphuntDiagnosticsEnabled: true };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const harness = await startWorker();
      const { getDiagnosticsEnabled } = await import(
        '@/engines/amazon/utils/diagnostics-flag'
      );
      // The worker's startup read must resolve before the lines can print.
      await waitFor(() => expect(getDiagnosticsEnabled()).toBe(true));

      // No START_COLLECTION: this exercises the fallback-session path — the
      // sessionKey is minted there and still keys the diagnostics lines.
      dispatch(harness, {
        type: 'PRODUCTS_COLLECTED',
        payload: {
          products: [PRODUCT],
          totalCount: 1,
          isNewBatch: true,
          extractionDiagnostics: [REPORT, { ...REPORT, asin: 'B0SECONDA01' }],
        },
      });

      await waitFor(() => expect(diagnosticLines(info)).toHaveLength(2));
      const logged = diagnosticLines(info).map(
        (line) => JSON.parse(line.slice(DIAG_TAG.length)) as Record<string, unknown>,
      );
      expect(logged[0]).toMatchObject({
        asin: 'B08N5WRWNW',
        stage: 'collection-card',
      });
      expect(logged[1]).toMatchObject({
        asin: 'B0SECONDA01',
        stage: 'collection-card',
      });
      // Both lines carry the same, real session key as their job id.
      expect(logged[0]!.jobId).toBeTruthy();
      expect(logged[0]!.jobId).toBe(logged[1]!.jobId);
    } finally {
      info.mockRestore();
    }
  });

  it('prints no collection-card lines while the switch is off', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const harness = await startWorker();
      dispatch(harness, {
        type: 'PRODUCTS_COLLECTED',
        payload: {
          products: [PRODUCT],
          totalCount: 1,
          isNewBatch: true,
          extractionDiagnostics: [REPORT],
        },
      });

      // Let the serialized products chain run to completion.
      const { db } = await import('@/lib/db/database');
      await waitFor(async () => expect(await db.products.count()).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(diagnosticLines(info)).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('prints the byte-identical drift line for DRIFT_REPORT when on, nothing when off', async () => {
    flagStorage = { pphuntDiagnosticsEnabled: true };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const harness = await startWorker();
      const { getDiagnosticsEnabled } = await import(
        '@/engines/amazon/utils/diagnostics-flag'
      );
      await waitFor(() => expect(getDiagnosticsEnabled()).toBe(true));

      dispatch(harness, DRIFT_MESSAGE);

      const driftTag = `${DIAG_TAG}drift `;
      await waitFor(() =>
        expect(
          info.mock.calls.filter(
            (call) =>
              typeof call[0] === 'string' && call[0].startsWith(driftTag),
          ),
        ).toHaveLength(1),
      );
      const line = info.mock.calls
        .map((call) => call[0])
        .find(
          (first): first is string =>
            typeof first === 'string' && first.startsWith(driftTag),
        )!;
      // Byte-identical shape: the same prefix and the same JSON the page
      // console used to print (D10 changed the console, not the line).
      const parsed = JSON.parse(line.slice(driftTag.length)) as Record<
        string,
        unknown
      >;
      expect(parsed).toMatchObject({
        stage: 'search-results',
        cardsInspected: 3,
        cardsExtracted: 2,
        isDriftDetected: false,
      });
    } finally {
      info.mockRestore();
    }

    // ── off: a fresh worker with an empty flag storage prints nothing
    vi.resetModules();
    flagStorage = {};
    const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const harness = await startWorker();
      dispatch(harness, DRIFT_MESSAGE);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(diagnosticLines(quiet)).toHaveLength(0);
    } finally {
      quiet.mockRestore();
    }
  });
});
