/**
 * SAD-295 (P4.1) - the service worker's offscreen client.
 *
 * Chrome allows exactly one offscreen document per extension, so the two
 * properties that matter most are: two simultaneous jobs never call
 * `createDocument()` twice, and an existing document (including one another
 * caller just created) is adopted rather than duplicated. The rest is the typed
 * request/response seam and the idle close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OFFSCREEN_IDLE_CLOSE_MS,
  closeOffscreen,
  createBlobUrlViaOffscreen,
  ensureOffscreen,
  isOffscreenSupported,
  parsePdpHtmlViaOffscreen,
  resetOffscreenForTests,
  type OffscreenEnvironment,
} from '@/engines/amazon/background/offscreen';
import { OFFSCREEN_TARGET } from '@/engines/amazon/offscreen/protocol';

const DOC_URL = 'chrome-extension://ext/offscreen.html';
const PRODUCT_URL = 'https://www.amazon.com/dp/B0DELTA123';

const PDP_HTML =
  '<!doctype html><html><body><span id="productTitle">Delta Widget</span>' +
  '<span id="acrCustomerReviewText">1,204 ratings</span></body></html>';

function environment(
  overrides: {
    offscreen?: Partial<NonNullable<OffscreenEnvironment['offscreen']>>;
    runtime?: Partial<NonNullable<OffscreenEnvironment['runtime']>>;
  } = {},
): OffscreenEnvironment {
  return {
    offscreen: {
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
      ...overrides.offscreen,
    },
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://ext/${path}`),
      sendMessage: vi.fn(async () => ({ ok: true })),
      ...overrides.runtime,
    },
  };
}

beforeEach(() => {
  resetOffscreenForTests();
});

afterEach(() => {
  resetOffscreenForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isOffscreenSupported', () => {
  it('is false without an offscreen API (Firefox, old Chrome)', () => {
    expect(isOffscreenSupported({ offscreen: null, runtime: null })).toBe(false);
    expect(
      isOffscreenSupported({ offscreen: {}, runtime: {} }),
    ).toBe(false);
  });

  it('is true as soon as createDocument exists', () => {
    expect(isOffscreenSupported(environment())).toBe(true);
  });
});

describe('ensureOffscreen', () => {
  it('creates the document with the parse reason and the right URL', async () => {
    const env = environment();

    await expect(ensureOffscreen({ env })).resolves.toBe(true);

    expect(env.offscreen?.createDocument).toHaveBeenCalledTimes(1);
    expect(env.offscreen?.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: DOC_URL,
        reasons: ['DOM_PARSER'],
      }),
    );
  });

  it('creates exactly one document for two simultaneous callers', async () => {
    const createDocument = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    );
    const env = environment({ offscreen: { createDocument } });

    const [first, second] = await Promise.all([
      ensureOffscreen({ env }),
      ensureOffscreen({ env }),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('adopts a document that is already open (getContexts)', async () => {
    const createDocument = vi.fn(async () => undefined);
    const env = environment({
      offscreen: { createDocument },
      runtime: {
        getContexts: vi.fn(async () => [
          { contextType: 'OFFSCREEN_DOCUMENT', documentUrl: DOC_URL },
        ]),
      },
    });

    await expect(ensureOffscreen({ env })).resolves.toBe(true);
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('falls back to hasDocument() when getContexts is unavailable', async () => {
    const createDocument = vi.fn(async () => undefined);
    const env = environment({
      offscreen: { createDocument, hasDocument: vi.fn(async () => true) },
    });

    await expect(ensureOffscreen({ env })).resolves.toBe(true);
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('adopts a document another caller created during the race', async () => {
    const getContexts = vi
      .fn<() => Promise<Array<{ contextType: string; documentUrl: string }>>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: DOC_URL }]);
    const env = environment({
      offscreen: {
        createDocument: vi.fn(async () => {
          throw new Error('Only a single offscreen document may be created.');
        }),
      },
      runtime: { getContexts },
    });

    await expect(ensureOffscreen({ env })).resolves.toBe(true);
  });

  it('reports failure when creation fails and nothing exists', async () => {
    const env = environment({
      offscreen: {
        createDocument: vi.fn(async () => {
          throw new Error('nope');
        }),
      },
      runtime: { getContexts: vi.fn(async () => []) },
    });

    await expect(ensureOffscreen({ env })).resolves.toBe(false);
  });

  it('is false when the API is missing entirely', async () => {
    await expect(
      ensureOffscreen({ env: { offscreen: null, runtime: null } }),
    ).resolves.toBe(false);
  });
});

describe('parsePdpHtmlViaOffscreen', () => {
  it('sends the parse request and returns the typed response', async () => {
    const product = { asin: 'B0DELTA123', title: 'Delta Widget' };
    const sendMessage = vi.fn(async () => ({ ok: true, product }));
    const env = environment({ runtime: { sendMessage } });

    const result = await parsePdpHtmlViaOffscreen(PDP_HTML, PRODUCT_URL, 'B0DELTA123', {
      env,
    });

    expect(result).toEqual({ ok: true, product });
    expect(sendMessage).toHaveBeenCalledWith({
      target: OFFSCREEN_TARGET,
      type: 'OFFSCREEN_PARSE_PRODUCT',
      html: PDP_HTML,
      productUrl: PRODUCT_URL,
      asin: 'B0DELTA123',
    });
  });

  it('omits the ASIN when the caller does not know it', async () => {
    const sendMessage = vi.fn(async (_message: unknown) => ({ ok: true, product: {} }));
    const env = environment({ runtime: { sendMessage } });

    await parsePdpHtmlViaOffscreen(PDP_HTML, PRODUCT_URL, undefined, { env });

    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('asin');
  });

  it('parses inline where the worker has a DOM (Firefox event page)', async () => {
    const result = await parsePdpHtmlViaOffscreen(PDP_HTML, PRODUCT_URL, undefined, {
      env: { offscreen: null, runtime: null },
    });

    // jsdom provides DOMParser, which is exactly the Firefox situation: no
    // offscreen document, but parsing still works.
    expect(typeof DOMParser).not.toBe('undefined');
    expect(result.ok).toBe(true);
  });

  it('returns a typed error when the document does not answer', async () => {
    const env = environment({
      runtime: { sendMessage: vi.fn(async () => undefined) },
    });

    const result = await parsePdpHtmlViaOffscreen(PDP_HTML, PRODUCT_URL, undefined, { env });

    expect(result).toMatchObject({ ok: false, code: 'PARSE_FAILED' });
  });

  it('reports a rejected sendMessage as a typed error, not a throw', async () => {
    const env = environment({
      runtime: {
        sendMessage: vi.fn(async () => {
          throw new Error('message port closed');
        }),
      },
    });

    const result = await parsePdpHtmlViaOffscreen(PDP_HTML, PRODUCT_URL, undefined, { env });

    expect(result).toMatchObject({ ok: false, code: 'PARSE_FAILED' });
    if (result.ok) return;
    expect(result.message).toContain('message port closed');
  });
});

describe('blob client', () => {
  it('claims the BLOBS reason when a file is actually being built', async () => {
    const env = environment({
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, url: 'blob:1', size: 3 })) },
    });

    const result = await createBlobUrlViaOffscreen('text/csv', 'YSxi', { env });

    expect(result).toEqual({ ok: true, url: 'blob:1', size: 3 });
    expect(env.offscreen?.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ reasons: ['DOM_PARSER', 'BLOBS'] }),
    );
  });
});

describe('idle close', () => {
  it('closes the document after 30 s with no requests, but not while one is in flight', async () => {
    vi.useFakeTimers();
    const closeDocument = vi.fn(async () => undefined);
    const sendMessage = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, product: {} }), 1_000);
        }),
    );
    const env = environment({ offscreen: { closeDocument }, runtime: { sendMessage } });

    const pending = parsePdpHtmlViaOffscreen(PDP_HTML, PRODUCT_URL, undefined, { env });

    // The timer that would close the document fires while the request is open.
    await vi.advanceTimersByTimeAsync(OFFSCREEN_IDLE_CLOSE_MS);
    expect(closeDocument).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    await vi.advanceTimersByTimeAsync(OFFSCREEN_IDLE_CLOSE_MS);
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  it('closeOffscreen is a no-op without closeDocument', async () => {
    await expect(closeOffscreen()).resolves.toBeUndefined();
  });
});
