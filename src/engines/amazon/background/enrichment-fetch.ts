import {
  AMAZON_MARKETPLACE_DOMAINS,
  extractASIN,
  isAmazonUrl,
} from '../utils/amazon-url';

/**
 * SAD-288 (plan 10.1 / R6): fetch a product page from the service worker.
 *
 * Why the background and not the page: a content-script `fetch` is subject to
 * the *page's* CORS policy (Chrome 85+), so it cannot read a PDP cross-origin.
 * An extension-origin fetch bypasses CORS for hosts in `host_permissions` - and
 * only for those, which is why the pre-flight permission check exists.
 *
 * Everything that can go wrong has a name. The caller (P4.3) never sees a
 * throw: it gets one of the outcomes below and decides whether to keep the
 * listing data (it always does - enrichment is an upgrade, never a rewrite).
 *
 * No DOM API is used here: the service worker has no `DOMParser`, so the CAPTCHA
 * probe is a text probe that mirrors the phrases `detectPageIssues()` looks for
 * in a parsed document.
 */

export const PDP_FETCH_TIMEOUT_MS = 12_000;
export const PDP_RETRY_DELAY_MS = 1_500;
/** A fetched PDP is ~1-2 MB; anything larger is not a page we can trust. */
export const MAX_PDP_HTML_BYTES = 3_000_000;
export const CIRCUIT_CAPTCHA_THRESHOLD = 3;
export const CIRCUIT_RATE_LIMIT_THRESHOLD = 3;
export const CIRCUIT_RATE_LIMIT_WINDOW_MS = 60_000;
export const CIRCUIT_COOLDOWN_MS = 60_000;

export type EnrichmentSkipReason = 'not-amazon' | 'no-permission' | 'circuit-open';

export type EnrichmentFailureStatus =
  | 'not-found'
  | 'captcha'
  | 'blocked'
  | 'timeout'
  | 'asin-mismatch'
  | 'parse-failed';

export type EnrichmentOutcome =
  | { status: 'ok'; html: string; finalUrl: string; httpStatus: number }
  | { status: 'skipped'; reason: EnrichmentSkipReason; message: string }
  | {
      status: EnrichmentFailureStatus;
      message: string;
      httpStatus?: number;
    };

export interface FetchPdpOptions {
  /** Logged with every failure so a stuck job can be traced. */
  jobId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Injectable for tests: the API is absent in jsdom. */
  hasHostPermission?: (origin: string) => Promise<boolean>;
}

interface CircuitState {
  captchaStreak: number;
  rateLimitedAt: number[];
  cooldownUntil: number;
}

const circuits = new Map<string, CircuitState>();

export function resetEnrichmentCircuitForTests(): void {
  circuits.clear();
}

function circuitFor(host: string): CircuitState {
  const existing = circuits.get(host);
  if (existing) return existing;
  const created: CircuitState = {
    captchaStreak: 0,
    rateLimitedAt: [],
    cooldownUntil: 0,
  };
  circuits.set(host, created);
  return created;
}

/** True when this host has tripped the breaker and is still cooling down. */
export function isCircuitOpen(host: string, nowMs: number = Date.now()): boolean {
  const state = circuits.get(host);
  if (!state) return false;
  return state.cooldownUntil > nowMs;
}

/**
 * Records one outcome against the host's breaker.
 *
 * Three captchas in a row, or three 429s inside a minute, take the host out of
 * service for a minute. A single success resets the streak: the breaker is
 * about "Amazon is refusing this client", not about lifetime counts.
 */
export function recordEnrichmentOutcome(
  host: string,
  kind: 'ok' | 'captcha' | 'rate-limited' | 'other',
  nowMs: number = Date.now(),
): void {
  const state = circuitFor(host);

  if (kind === 'ok') {
    state.captchaStreak = 0;
    state.rateLimitedAt = [];
    return;
  }

  if (kind === 'captcha') {
    state.captchaStreak += 1;
    if (state.captchaStreak >= CIRCUIT_CAPTCHA_THRESHOLD) {
      state.cooldownUntil = nowMs + CIRCUIT_COOLDOWN_MS;
      state.captchaStreak = 0;
    }
    return;
  }

  if (kind === 'rate-limited') {
    state.rateLimitedAt = [
      ...state.rateLimitedAt.filter(
        (at) => nowMs - at < CIRCUIT_RATE_LIMIT_WINDOW_MS,
      ),
      nowMs,
    ];
    if (state.rateLimitedAt.length >= CIRCUIT_RATE_LIMIT_THRESHOLD) {
      state.cooldownUntil = nowMs + CIRCUIT_COOLDOWN_MS;
      state.rateLimitedAt = [];
    }
  }
}

/** Phrases `detectPageIssues()` treats as a challenge, applied to raw HTML. */
export function looksLikeChallenge(html: string): boolean {
  const text = html.slice(0, 200_000);
  return (
    /Enter the characters you see below/i.test(text) ||
    /Type the characters you see in this image/i.test(text) ||
    /api-services-support@amazon/i.test(text) ||
    /\/errors\/validateCaptcha/i.test(text) ||
    /id=["']captchacharacters["']/i.test(text) ||
    /Sorry,\s*we just need to make sure you(?:'re| are) not a robot/i.test(text)
  );
}

async function defaultHasHostPermission(origin: string): Promise<boolean> {
  try {
    const g = globalThis as unknown as {
      browser?: { permissions?: { contains?: (p: { origins: string[] }) => Promise<boolean> } };
      chrome?: { permissions?: { contains?: (p: { origins: string[] }) => Promise<boolean> } };
    };
    const permissions = g.browser?.permissions ?? g.chrome?.permissions;
    if (typeof permissions?.contains !== 'function') {
      // Host permissions come from the manifest; without the API (old browsers,
      // tests) assume the install-time grant is what the manifest declared.
      return true;
    }
    return await permissions.contains({ origins: [origin] });
  } catch {
    return true;
  }
}

function logFailure(
  outcome: EnrichmentOutcome,
  context: { jobId?: string; asin?: string; url: string },
): void {
  if (outcome.status === 'ok') return;

  const detail = {
    ...(context.jobId ? { jobId: context.jobId } : {}),
    asin: context.asin,
    url: context.url,
    status: outcome.status,
    ...(outcome.status === 'skipped' ? { reason: outcome.reason } : {}),
    ...('httpStatus' in outcome && outcome.httpStatus
      ? { httpStatus: outcome.httpStatus }
      : {}),
    message: outcome.message,
  };

  try {
    console.warn('[PPHunt] enrichment failed', detail);
  } catch {
    // A logging failure must never fail the save.
  }
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(timeoutMs);
    }
  } catch {
    // Fall through: no signal means no client-side deadline.
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Fetches one PDP and classifies the result.
 *
 * Retry policy: **one** retry, 1.5 s later, and only for a timeout or a 5xx.
 * A captcha, a 403/429 or an ASIN mismatch is never retried - retrying those is
 * exactly the behaviour that turns a soft block into a hard one.
 */
export async function fetchPdpHtml(
  productUrl: string,
  asin: string,
  options: FetchPdpOptions = {},
): Promise<EnrichmentOutcome> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);

  const fail = (outcome: EnrichmentOutcome) => {
    logFailure(outcome, { jobId: options.jobId, asin, url: productUrl });
    return outcome;
  };

  let hostname = '';
  try {
    hostname = new URL(productUrl).hostname;
  } catch {
    return fail({ status: 'skipped', reason: 'not-amazon', message: 'Invalid product URL' });
  }

  if (!isAmazonUrl(productUrl)) {
    return fail({
      status: 'skipped',
      reason: 'not-amazon',
      message: 'Not an Amazon product URL',
    });
  }

  // One breaker per marketplace, not per subdomain: www.amazon.de and
  // amazon.de are the same client being refused.
  const host =
    AMAZON_MARKETPLACE_DOMAINS.find(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    ) ?? hostname;

  const hasPermission = options.hasHostPermission ?? defaultHasHostPermission;
  const granted = await hasPermission(`*://*.${host}/*`);
  if (!granted) {
    return fail({
      status: 'skipped',
      reason: 'no-permission',
      message: `No host permission for ${host}`,
    });
  }

  if (isCircuitOpen(host, now())) {
    return fail({
      status: 'skipped',
      reason: 'circuit-open',
      message: `Paused after repeated blocks from ${host}`,
    });
  }

  if (typeof fetchImpl !== 'function') {
    return fail({
      status: 'blocked',
      message: 'fetch is unavailable in this context',
    });
  }

  const expectedAsin = asin.trim().toUpperCase();
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;

    try {
      response = await fetchImpl(productUrl, {
        // Public PDP data: no cookies, so a signed-in session is never used and
        // never leaked into the request.
        credentials: 'omit',
        redirect: 'follow',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: timeoutSignal(options.timeoutMs ?? PDP_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = isAbortError(error);
      if (timedOut && attempt === 0) {
        await sleep(PDP_RETRY_DELAY_MS);
        continue;
      }
      return fail({
        status: timedOut ? 'timeout' : 'blocked',
        message: timedOut
          ? 'The product page took too long to load'
          : error instanceof Error
            ? error.message
            : 'The product page could not be fetched',
      });
    }

    lastStatus = response.status;

    if (response.status >= 500 && attempt === 0) {
      await sleep(PDP_RETRY_DELAY_MS);
      continue;
    }

    if (response.status === 429) {
      recordEnrichmentOutcome(host, 'rate-limited', now());
      return fail({
        status: 'blocked',
        httpStatus: 429,
        message: 'Amazon is rate limiting requests',
      });
    }

    if (response.status === 404 || response.status === 410) {
      return fail({
        status: 'not-found',
        httpStatus: response.status,
        message: 'The product page no longer exists',
      });
    }

    if (!response.ok) {
      return fail({
        status: 'blocked',
        httpStatus: response.status,
        message: `Amazon returned HTTP ${response.status}`,
      });
    }

    const contentType = (response.headers?.get?.('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/html')) {
      return fail({
        status: 'parse-failed',
        httpStatus: response.status,
        message: `Unexpected content type: ${contentType || 'none'}`,
      });
    }

    const declaredLength = Number(response.headers?.get?.('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PDP_HTML_BYTES) {
      return fail({
        status: 'parse-failed',
        httpStatus: response.status,
        message: 'The product page is too large to enrich from',
      });
    }

    let html: string;
    try {
      html = await response.text();
    } catch (error) {
      return fail({
        status: 'parse-failed',
        httpStatus: response.status,
        message: error instanceof Error ? error.message : 'Could not read the page',
      });
    }

    if (html.length > MAX_PDP_HTML_BYTES) {
      return fail({
        status: 'parse-failed',
        httpStatus: response.status,
        message: 'The product page is too large to enrich from',
      });
    }

    if (looksLikeChallenge(html)) {
      recordEnrichmentOutcome(host, 'captcha', now());
      return fail({
        status: 'captcha',
        httpStatus: response.status,
        message: 'Amazon showed a CAPTCHA instead of the product',
      });
    }

    const finalUrl = response.url || productUrl;
    const finalAsin = extractASIN(finalUrl);
    if (!finalAsin || finalAsin.toUpperCase() !== expectedAsin) {
      // A variant redirect or an interstitial: mixing two products' fields is
      // worse than no enrichment at all.
      return fail({
        status: 'asin-mismatch',
        httpStatus: response.status,
        message: `Page resolved to ${finalAsin ?? 'no ASIN'}, expected ${expectedAsin}`,
      });
    }

    recordEnrichmentOutcome(host, 'ok', now());
    return { status: 'ok', html, finalUrl, httpStatus: response.status };
  }

  return fail({
    status: 'blocked',
    ...(lastStatus ? { httpStatus: lastStatus } : {}),
    message: 'Amazon kept returning a server error',
  });
}
