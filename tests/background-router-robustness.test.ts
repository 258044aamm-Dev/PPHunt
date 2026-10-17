/**
 * Step 2.4 (SAD-164) — H-3 + C-2: both routers Zod-validate every message
 * and discard invalid ones without throwing.
 *
 * Drives the REAL listeners registered by background.ts and
 * amazon.content.ts (no re-implementation): before this step, 7 message
 * types threw on an undefined payload and `sendResponse` was called 0 times,
 * leaving the sender with a closed channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirror the loose listener signatures */
type Listener = (...args: any[]) => any;

function event() {
  let listener: Listener = () => {};
  return {
    addListener: vi.fn((callback: Listener) => {
      listener = callback;
    }),
    emit: (...args: any[]) => listener(...args),
    current: () => listener,
  };
}

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
    storage: { local: { get: vi.fn().mockResolvedValue({}) }, onChanged: event() },
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
  return { browser: mockBrowser, onMessage };
}

const SENDER = {
  id: 1,
  tab: { url: 'https://www.amazon.de/s?k=test', status: 'complete' },
};

function drive(onMessage: ReturnType<typeof event>, message: unknown) {
  const sendResponse = vi.fn();
  const listener = onMessage.current() as (
    message: unknown,
    sender: unknown,
    respond: (response?: unknown) => void
  ) => unknown;
  let thrown: unknown = null;
  let result: unknown;
  try {
    result = listener(message, SENDER, sendResponse);
  } catch (err) {
    thrown = err;
  }
  return { result, sendResponse, thrown };
}

/** The 11 schema types whose payload is a required object. */
const PAYLOAD_BEARING_TYPES = [
  'START_COLLECTION',
  'RELOAD_AND_RETRY_COLLECTION',
  'PAUSE_COLLECTION',
  'RESUME_COLLECTION',
  'STOP_COLLECTION',
  'COLLECT_PRODUCTS',
  'PRODUCTS_COLLECTED',
  'COLLECTION_PROGRESS',
  'CONTENT_ERROR',
  'UPDATE_PROGRESS',
  'TAB_STATUS_CHANGED',
] as const;

/** The 3 schema types with no payload key (the H-3 undefined-payload path). */
const PAYLOAD_LESS_TYPES = [
  'PAUSE_SCROLLING',
  'RESUME_SCROLLING',
  'STOP_COLLECTION_CMD',
] as const;

const MALFORMED_PAYLOADS: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['empty object', {}],
  ['wrong shape', { wrong: 'shape' }],
];

const MATRIX = PAYLOAD_BEARING_TYPES.flatMap((type) =>
  MALFORMED_PAYLOADS.map(
    ([label, payload]) => [`${type} / payload=${label}`, { type, payload }] as const
  )
);

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('H-3: background router discards malformed messages without throwing', () => {
  it.each(MATRIX)(
    '%s → INVALID_MESSAGE exactly once, returns false, never throws',
    async (_label, message) => {
      const { onMessage } = await startBackground();
      const { result, sendResponse, thrown } = drive(onMessage, message);

      expect(thrown).toBeNull(); // the H-3 crash is gone
      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: 'INVALID_MESSAGE',
      });
      expect(result).toBe(false);
    }
  );

  it('unknown or missing types stay silent and return false (background.ts:634-635 behaviour preserved)', async () => {
    const { onMessage } = await startBackground();
    for (const message of [
      { type: 'TOTALLY_UNKNOWN' },
      { type: 'PING_CONTENT_SCRIPT' }, // not part of the protocol schema
      null,
      undefined,
      'a string',
      {},
      { type: 42 },
    ]) {
      const { result, sendResponse, thrown } = drive(onMessage, message);
      expect(thrown).toBeNull();
      expect(result).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    }
  });

  it('payload-less command types remain schema-valid whatever extra keys arrive; the background switch still ignores them via default', async () => {
    const { onMessage } = await startBackground();
    for (const type of PAYLOAD_LESS_TYPES) {
      for (const [, payload] of MALFORMED_PAYLOADS) {
        const { result, sendResponse, thrown } = drive(onMessage, {
          type,
          payload,
        });
        expect(thrown).toBeNull();
        expect(result).toBe(false);
        // background has no case for these (they flow background → content),
        // so the pre-existing `default: return false` path applies — no response.
        expect(sendResponse).not.toHaveBeenCalled();
      }
    }
  });

  it('a valid PRODUCTS_COLLECTED with one product still persists end-to-end', async () => {
    const { onMessage } = await startBackground();
    const { db } = await import('@/lib/db/database');
    const before = await db.products.count();

    const { result, sendResponse, thrown } = drive(onMessage, {
      type: 'PRODUCTS_COLLECTED',
      payload: {
        products: [
          {
            asin: 'B08N5WRWNW',
            title: 'Anker USB-C 65W Fast Wall Charger',
            url: 'https://www.amazon.de/dp/B08N5WRWNW',
            price: 39.99,
            currency: 'EUR',
            imageUrl: 'https://m.media-amazon.com/images/I/anker.jpg',
            rating: 4.7,
            reviewCount: 1234,
            source: 'search',
          },
        ],
        totalCount: 1,
        isNewBatch: true,
      },
    });

    expect(thrown).toBeNull();
    expect(result).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await waitFor(async () => {
      expect(await db.products.count()).toBe(before + 1);
    });
  });
});

describe('H-3: content-script router validates before the COLLECT_PRODUCTS ack', () => {
  async function startContentScript() {
    const onMessage = event();
    vi.stubGlobal('browser', {
      runtime: {
        onMessage,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.stubGlobal('defineContentScript', (cfg: unknown) => cfg);
    const { default: contentScript } = await import(
      '@/entrypoints/amazon.content'
    );
    (contentScript as unknown as { main: () => void }).main();
    return { onMessage };
  }

  const CONTENT_MATRIX = MALFORMED_PAYLOADS.map(([label, payload]) => [
    `COLLECT_PRODUCTS / payload=${label}`,
    { type: 'COLLECT_PRODUCTS', payload },
  ] as const);

  it.each(CONTENT_MATRIX)(
    '%s → INVALID_MESSAGE exactly once, returns false, never throws, never acks ok',
    async (_label, message) => {
      const { onMessage } = await startContentScript();
      const { result, sendResponse, thrown } = drive(onMessage, message);

      expect(thrown).toBeNull();
      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: 'INVALID_MESSAGE',
      });
      expect(sendResponse).not.toHaveBeenCalledWith({ ok: true });
      expect(result).toBe(false);
    }
  );

  it('PING_CONTENT_SCRIPT (outside the schema) is still answered', async () => {
    const { onMessage } = await startContentScript();
    const { result, sendResponse, thrown } = drive(onMessage, {
      type: 'PING_CONTENT_SCRIPT',
    });
    expect(thrown).toBeNull();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, url: expect.any(String) });
    expect(result).toBe(false);
  });

  it.each(MALFORMED_PAYLOADS.map(([label, payload]) => [label, payload] as const))(
    'PAUSE_SCROLLING with payload=%s stays valid and is handled (ok ack)',
    async (_label, payload) => {
      const { onMessage } = await startContentScript();
      const { result, sendResponse, thrown } = drive(onMessage, {
        type: 'PAUSE_SCROLLING',
        payload,
      });
      expect(thrown).toBeNull();
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      expect(result).toBe(false);
    }
  );
});

describe('validateExtensionMessage: outcome discrimination', () => {
  it('separates unknown types (silent) from known types with bad payloads (INVALID_MESSAGE)', async () => {
    const { validateExtensionMessage } = await import('@/lib/schemas');
    expect(validateExtensionMessage({ type: 'NOT_A_TYPE' }).status).toBe('unknown');
    expect(validateExtensionMessage(null).status).toBe('unknown');
    expect(validateExtensionMessage({}).status).toBe('unknown');

    const invalid = validateExtensionMessage({
      type: 'PAUSE_COLLECTION',
      payload: {},
    });
    expect(invalid.status).toBe('invalid');
    if (invalid.status === 'invalid') {
      expect(invalid.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns the ORIGINAL message object so extra payload fields survive the gate (no Zod key stripping)', async () => {
    const { validateExtensionMessage } = await import('@/lib/schemas');
    const raw = {
      type: 'COLLECT_PRODUCTS',
      payload: { mode: 'manual', targetCount: 25, existingAsins: ['B0ABC'] },
    };
    const result = validateExtensionMessage(raw);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.message).toBe(raw); // identity, not parsed.data
      expect(
        (result.message as { payload: { existingAsins?: string[] } }).payload
          .existingAsins
      ).toEqual(['B0ABC']);
    }
  });
});
