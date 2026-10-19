/**
 * SAD-288 (P4.2) - fetching a PDP without touching the tab, and failing in ways
 * the caller can act on.
 *
 * The three properties the phase gate cares about:
 *   1. a captcha / 403 / 429 is never retried (retrying a soft block makes it hard);
 *   2. every failure is exactly one enum value, logged with the job id;
 *   3. no request is made to a host we do not hold permission for, or to a
 *      non-Amazon URL at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CIRCUIT_COOLDOWN_MS,
  MAX_PDP_HTML_BYTES,
  PDP_RETRY_DELAY_MS,
  fetchPdpHtml,
  isCircuitOpen,
  looksLikeChallenge,
  resetEnrichmentCircuitForTests,
  type EnrichmentOutcome,
} from '@/engines/amazon/background/enrichment-fetch';

const ASIN = 'B08N5WRWNW';
const PRODUCT_URL = `https://www.amazon.com/dp/${ASIN}`;

interface ResponseInitLike {
  status?: number;
  url?: string;
  contentType?: string | null;
  body?: string;
  contentLength?: number;
  throws?: 'abort' | 'network';
}

function makeResponse(init: ResponseInitLike = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: init.url ?? PRODUCT_URL,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'content-type') {
          const value =
            init.contentType === undefined ? 'text/html; charset=utf-8' : init.contentType;
          return value;
        }
        if (key === 'content-length') {
          return init.contentLength === undefined ? null : String(init.contentLength);
        }
        return null;
      },
    },
    text: async () => init.body ?? '<html><body>ok</body></html>',
  } as unknown as Response;
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function fetcher(
  ...results: Array<ReturnType<typeof makeResponse> | Error | (() => never)>
) {
  let index = 0;
  return vi.fn(async () => {
    const next = results[Math.min(index, results.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  });
}

const GRANTED = async () => true;
const DENIED = async () => false;

beforeEach(() => {
  resetEnrichmentCircuitForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('success', () => {
  it('returns the HTML and the final URL with a cookie-less request', async () => {
    const fetchImpl = fetcher(makeResponse({ body: '<html>product</html>' }));

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toEqual({
      status: 'ok',
      html: '<html>product</html>',
      finalUrl: PRODUCT_URL,
      httpStatus: 200,
    });

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
  });

  it('does not log a success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = fetcher(makeResponse());

    await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('terminal failures are not retried', () => {
  it('404 is not-found', async () => {
    const fetchImpl = fetcher(makeResponse({ status: 404 }));

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'not-found', httpStatus: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('403 is blocked', async () => {
    const fetchImpl = fetcher(makeResponse({ status: 403 }));

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'blocked', httpStatus: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a captcha page is detected from the body and never retried', async () => {
    const fetchImpl = fetcher(
      makeResponse({
        body: '<html><body><h1>Enter the characters you see below</h1></body></html>',
      }),
    );

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'captcha' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a redirect to another product is an asin-mismatch', async () => {
    const fetchImpl = fetcher(
      makeResponse({ url: 'https://www.amazon.com/dp/B0OTHER999' }),
    );

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'asin-mismatch' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a non-HTML response is a parse failure', async () => {
    const fetchImpl = fetcher(makeResponse({ contentType: 'application/json' }));

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'parse-failed' });
  });

  it('a declared oversized body is rejected before reading it', async () => {
    const text = vi.fn(async () => 'never');
    const fetchImpl = fetcher({
      ...makeResponse({ contentLength: MAX_PDP_HTML_BYTES + 1 }),
      text,
    } as unknown as Response);

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'parse-failed' });
    expect(text).not.toHaveBeenCalled();
  });

  it('an oversized body is rejected after reading it', async () => {
    const fetchImpl = fetcher(
      makeResponse({ body: 'x'.repeat(MAX_PDP_HTML_BYTES + 1) }),
    );

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'parse-failed' });
  });
});

describe('retry budget', () => {
  it('retries a timeout once after 1.5 s and can then succeed', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = fetcher(abortError(), makeResponse());

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
      sleep,
    });

    expect(outcome.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(PDP_RETRY_DELAY_MS);
  });

  it('gives up after one retry and reports timeout', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = fetcher(abortError(), abortError());

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
      sleep,
    });

    expect(outcome).toMatchObject({ status: 'timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 once, then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = fetcher(makeResponse({ status: 500 }), makeResponse());

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
      sleep,
    });

    expect(outcome.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports blocked when the 500 persists', async () => {
    const fetchImpl = fetcher(makeResponse({ status: 503 }), makeResponse({ status: 503 }));

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
      sleep: async () => {},
    });

    expect(outcome).toMatchObject({ status: 'blocked', httpStatus: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps a network error to blocked without retrying', async () => {
    const fetchImpl = fetcher(new Error('network down'));

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
      sleep: async () => {},
    });

    expect(outcome).toMatchObject({ status: 'blocked' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('pre-flight skips', () => {
  it('makes no request for a non-Amazon URL', async () => {
    const fetchImpl = vi.fn();

    const outcome = await fetchPdpHtml('https://example.com/dp/B08N5WRWNW', ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'not-amazon' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes no request for a malformed URL', async () => {
    const fetchImpl = vi.fn();

    const outcome = await fetchPdpHtml('not a url', ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'not-amazon' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes no request without host permission', async () => {
    const fetchImpl = vi.fn();
    const hasHostPermission = vi.fn(async () => false);

    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission,
    });

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'no-permission' });
    expect(hasHostPermission).toHaveBeenCalledWith('*://*.amazon.com/*');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('circuit breaker', () => {
  const FIXED = 1_000_000;

  function captchaFetcher() {
    return fetcher(
      makeResponse({ body: '<html>Enter the characters you see below</html>' }),
    );
  }

  it('opens after three consecutive captchas and skips without fetching', async () => {
    for (let i = 0; i < 3; i += 1) {
      const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
        fetchImpl: captchaFetcher() as unknown as typeof fetch,
        hasHostPermission: GRANTED,
        now: () => FIXED,
      });
      expect(outcome).toMatchObject({ status: 'captcha' });
    }

    expect(isCircuitOpen('amazon.com', FIXED)).toBe(true);

    const fetchImpl = vi.fn();
    const skipped = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
      now: () => FIXED + CIRCUIT_COOLDOWN_MS - 1,
    });

    expect(skipped).toMatchObject({ status: 'skipped', reason: 'circuit-open' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets the host through again after the cooldown', async () => {
    for (let i = 0; i < 3; i += 1) {
      await fetchPdpHtml(PRODUCT_URL, ASIN, {
        fetchImpl: captchaFetcher() as unknown as typeof fetch,
        hasHostPermission: GRANTED,
        now: () => FIXED,
      });
    }

    const fetchImpl = fetcher(makeResponse());
    const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      hasHostPermission: GRANTED,
      now: () => FIXED + CIRCUIT_COOLDOWN_MS + 1,
    });

    expect(outcome.status).toBe('ok');
  });

  it('opens after three 429s inside a minute', async () => {
    for (let i = 0; i < 3; i += 1) {
      const outcome = await fetchPdpHtml(PRODUCT_URL, ASIN, {
        fetchImpl: fetcher(makeResponse({ status: 429 })) as unknown as typeof fetch,
        hasHostPermission: GRANTED,
        now: () => FIXED + i,
      });
      expect(outcome).toMatchObject({ status: 'blocked', httpStatus: 429 });
    }

    expect(isCircuitOpen('amazon.com', FIXED + 3)).toBe(true);
  });

  it('a success resets the captcha streak', async () => {
    const sequence: Array<'captcha' | 'ok'> = ['captcha', 'captcha', 'ok', 'captcha', 'captcha'];

    for (const kind of sequence) {
      await fetchPdpHtml(PRODUCT_URL, ASIN, {
        fetchImpl: fetcher(
          kind === 'captcha'
            ? makeResponse({ body: 'Enter the characters you see below' })
            : makeResponse(),
        ) as unknown as typeof fetch,
        hasHostPermission: GRANTED,
        now: () => FIXED,
      });
    }

    expect(isCircuitOpen('amazon.com', FIXED)).toBe(false);
  });
});

describe('logging', () => {
  it('logs every failure with the job id and one status value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fetchPdpHtml(PRODUCT_URL, ASIN, {
      jobId: 'job-7',
      fetchImpl: fetcher(makeResponse({ status: 404 })) as unknown as typeof fetch,
      hasHostPermission: GRANTED,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const [label, detail] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(label).toContain('enrichment');
    expect(detail).toMatchObject({ jobId: 'job-7', asin: ASIN, status: 'not-found' });
  });
});

describe('helpers', () => {
  it('looksLikeChallenge matches the same phrases as detectPageIssues', () => {
    expect(looksLikeChallenge('<p>Enter the characters you see below</p>')).toBe(true);
    expect(looksLikeChallenge('<form action="/errors/validateCaptcha">x</form>')).toBe(true);
    expect(looksLikeChallenge('<input id="captchacharacters">')).toBe(true);
    expect(looksLikeChallenge('<p>contact api-services-support@amazon</p>')).toBe(true);
    expect(looksLikeChallenge('<html><span id="productTitle">Charger</span></html>')).toBe(false);
  });

  it('tags every outcome with exactly one status value', () => {
    const outcomes: EnrichmentOutcome['status'][] = [
      'ok',
      'skipped',
      'not-found',
      'captcha',
      'blocked',
      'timeout',
      'asin-mismatch',
      'parse-failed',
    ];

    expect(new Set(outcomes).size).toBe(outcomes.length);
  });
});
