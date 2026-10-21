/**
 * SAD-383: the two numbers a listing card sometimes cannot give us.
 *
 * Measured 2026-10-21 (`docs/plans/SAD-383-evidence-2026-10-21.md` §3): Amazon's
 * average-customer-review popover answers with the same `rating` / `reviewCount`
 * the product page prints, in ~3 KB instead of ~2.6 MB, needs no cookies, and is
 * the same value a save ends up with — which is exactly the parity this ticket is
 * about.
 *
 * Two behaviours matter as much as the happy path:
 *
 * 1. **A non-existent ASIN answers HTTP 200.** `…asin=B0ZZZZZZZZ` returns
 *    `Average rating: 0.0 out of 5 stars` / `0 global ratings`. A parser that
 *    trusted it would stamp a fabricated `0.0` onto a real row, so callers must
 *    require a count of at least 1 (see `isUsableRatingPayload`).
 *
 * 2. **The breaker is shared with enrichment.** Rating fetches key on the same
 *    marketplace host as `fetchPdpHtml`, so a captcha storm on one surface pauses
 *    the other instead of doubling the request rate that caused it.
 *
 * No retry: the payload is 3 KB, so a retry buys nothing, and a second request
 * during a soft block is what turns it into a hard one. The breaker already
 * provides the "try again in a minute" behaviour.
 */
import { AMAZON_MARKETPLACE_DOMAINS, isAmazonUrl } from '../utils/amazon-url';
import {
  isCircuitOpen,
  looksLikeChallenge,
  recordEnrichmentOutcome,
} from './enrichment-fetch';

export const RATING_FETCH_TIMEOUT_MS = 8_000;
/** The popover is ~3 KB; 64 KB is already generous and bounds a bad response. */
export const MAX_RATING_HTML_BYTES = 64 * 1024;

export type RatingFetchOutcome =
  | { status: 'ok'; html: string }
  | { status: 'skipped'; reason: 'not-amazon' | 'circuit-open' }
  | {
      status: 'failed';
      reason: 'http' | 'captcha' | 'too-large' | 'network' | 'empty';
    };

export interface FetchRatingOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * The popover URL for a product on the same marketplace as `productUrl`.
 * Built from the product URL's origin so every marketplace (`.de`, `.co.uk`, …)
 * is answered by its own host rather than a hard-coded `.com`.
 */
export function ratingPopoverUrl(productUrl: string, asin: string): string | null {
  try {
    const origin = new URL(productUrl).origin;
    return `${origin}/gp/customer-reviews/widgets/average-customer-review/popover/?ie=UTF8&asin=${encodeURIComponent(asin)}`;
  } catch {
    return null;
  }
}

function marketplaceHost(productUrl: string): string | null {
  try {
    const hostname = new URL(productUrl).hostname;
    return (
      AMAZON_MARKETPLACE_DOMAINS.find(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      ) ?? hostname
    );
  } catch {
    return null;
  }
}

/**
 * SAD-383: one request, classified. Never throws — the caller is a background
 * queue whose failure policy is "leave the row alone".
 */
export async function fetchRatingPopover(
  productUrl: string,
  asin: string,
  options: FetchRatingOptions = {},
): Promise<RatingFetchOutcome> {
  if (!isAmazonUrl(productUrl) || !asin) {
    return { status: 'skipped', reason: 'not-amazon' };
  }

  const host = marketplaceHost(productUrl);
  const url = ratingPopoverUrl(productUrl, asin);
  if (!host || !url) {
    return { status: 'skipped', reason: 'not-amazon' };
  }

  const now = options.now ?? (() => Date.now());
  if (isCircuitOpen(host, now())) {
    return { status: 'skipped', reason: 'circuit-open' };
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchImpl !== 'function') {
    return { status: 'failed', reason: 'network' };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      // Public review data: no cookies, so a signed-in session is never used.
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal:
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(options.timeoutMs ?? RATING_FETCH_TIMEOUT_MS)
          : undefined,
    });
  } catch {
    recordEnrichmentOutcome(host, 'other', now());
    return { status: 'failed', reason: 'network' };
  }

  if (response.status === 429) {
    recordEnrichmentOutcome(host, 'rate-limited', now());
    return { status: 'failed', reason: 'http' };
  }

  if (!response.ok) {
    recordEnrichmentOutcome(host, 'other', now());
    return { status: 'failed', reason: 'http' };
  }

  let html: string;
  try {
    html = await response.text();
  } catch {
    recordEnrichmentOutcome(host, 'other', now());
    return { status: 'failed', reason: 'network' };
  }

  if (html.length > MAX_RATING_HTML_BYTES) {
    recordEnrichmentOutcome(host, 'other', now());
    return { status: 'failed', reason: 'too-large' };
  }

  if (looksLikeChallenge(html)) {
    // The shared breaker counts this, so three in a row pause the whole host.
    recordEnrichmentOutcome(host, 'captcha', now());
    return { status: 'failed', reason: 'captcha' };
  }

  if (!html.trim()) {
    recordEnrichmentOutcome(host, 'other', now());
    return { status: 'failed', reason: 'empty' };
  }

  recordEnrichmentOutcome(host, 'ok', now());
  return { status: 'ok', html };
}

/**
 * SAD-383: the honesty guard.
 *
 * A well-formed popover for an ASIN that does not exist reports
 * `0.0 out of 5` with `0 global ratings`, so a zero can never be told apart from
 * "no ratings yet". Writing it would put a fabricated rating on a real row, so a
 * payload is only usable when a review count exists and a rating is in (0, 5].
 */
export function isUsableRatingPayload(values: {
  rating: number | null;
  reviewCount: number | null;
}): boolean {
  const { rating, reviewCount } = values;
  return (
    typeof rating === 'number' &&
    Number.isFinite(rating) &&
    rating > 0 &&
    rating <= 5 &&
    typeof reviewCount === 'number' &&
    Number.isFinite(reviewCount) &&
    reviewCount >= 1
  );
}
