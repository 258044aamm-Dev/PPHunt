import { createFieldDiagnosticsCollector } from '../scraper/extraction-diagnostics';
import {
  parseRating,
  parseReviewCount,
  validateAndNormalizeScrapedProduct,
} from '../scraper/field-parsers';
import { parseAmazonProductDetail } from '../scraper/product-detail';
import { normalizeASIN } from '../utils/amazon-url';
import type { ScrapedProduct } from '../types';
import {
  MAX_OFFSCREEN_HTML_LENGTH,
  offscreenError,
  type OffscreenParseRatingResponse,
  type OffscreenParseResponse,
} from './protocol';

/**
 * SAD-295 (plan 10.2): parse a fetched product page.
 *
 * Two things are deliberate:
 *
 * 1. **The `<base>` tag.** No current parser reads `document.baseURI` -
 *    `parseAmazonProductDetail` works from raw `href`/`src` attributes and
 *    `extractBestImageUrl` rejects relative URLs by design. Injecting it changes
 *    nothing today; it is one line of insurance against a future helper that
 *    resolves `.href`. A test pins field parity with and without it.
 *
 * 2. **Nothing throws.** Every failure is a typed result, because an exception
 *    crossing `runtime.sendMessage` becomes a generic "message port closed"
 *    error that the caller cannot classify (and cannot retry sensibly).
 */

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inserts `<base href>` as early as possible in `<head>` (or at the front). */
export function withBaseHref(html: string, productUrl: string): string {
  const base = `<base href="${escapeAttribute(productUrl)}">`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (!head) return `${base}${html}`;
  const index = head.index + head[0].length;
  return `${html.slice(0, index)}${base}${html.slice(index)}`;
}

/**
 * Parses PDP HTML and validates the result with the same chain the content
 * script uses, so an offscreen parse can never be "looser" than a live one.
 */
export function parsePdpHtml(
  html: string,
  productUrl: string,
  expectedAsin?: string,
): OffscreenParseResponse {
  if (typeof DOMParser === 'undefined') {
    return offscreenError(
      'PARSE_UNAVAILABLE',
      'DOMParser is not available in this context',
    );
  }

  if (!html || html.length > MAX_OFFSCREEN_HTML_LENGTH) {
    return offscreenError('HTML_TOO_LARGE', 'Response body is too large to parse');
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(
      withBaseHref(html, productUrl),
      'text/html',
    );
  } catch (error) {
    return offscreenError(
      'PARSE_FAILED',
      error instanceof Error ? error.message : 'Could not parse HTML',
    );
  }

  // SAD-359: collect per-field extraction diagnostics alongside the parse and
  // ride them back on the response (success and parser-ran errors alike), so
  // the service worker can log them next to the enrichment outcome. The
  // product itself is unaffected.
  const diagnostics = createFieldDiagnosticsCollector();
  const parsed = parseAmazonProductDetail(doc, productUrl, diagnostics);
  const fieldDiagnostics = diagnostics.build();
  if (!parsed) {
    return {
      ...offscreenError('PARSE_FAILED', 'No product found on the fetched page'),
      fieldDiagnostics,
    };
  }

  const normalized = validateAndNormalizeScrapedProduct(parsed, productUrl);
  if (!normalized) {
    return {
      ...offscreenError('PARSER_REJECTED', 'Parsed product failed validation'),
      fieldDiagnostics,
    };
  }

  if (expectedAsin) {
    const wanted = normalizeASIN(expectedAsin);
    const got = normalizeASIN(normalized.asin);
    if (!got || got !== wanted) {
      // A variant redirect or an interstitial resolves to a different product.
      // Reporting it as this ASIN's details would silently corrupt the row.
      return {
        ...offscreenError(
          'PARSER_REJECTED',
          `Page resolved to ${normalized.asin || 'no ASIN'}, expected ${expectedAsin}`,
        ),
        fieldDiagnostics,
      };
    }
  }

  return { ok: true, product: normalized as ScrapedProduct, fieldDiagnostics };
}


/**
 * SAD-383: the average-customer-review popover.
 *
 * `data-hook` is locale-invariant, so the localized *text* is handed to the
 * existing `parseRating` / `parseReviewCount` — the same functions every listing
 * card has always used. `4,7 von 5 Sternen` and `142.457 Sternebewertungen` keep
 * working without a second number parser existing in the codebase.
 *
 * A challenge page is not a parse failure to retry: it returns two nulls and the
 * caller's circuit breaker has already been told (see `rating-fetch.ts`).
 */
export const ACR_SELECTORS = {
  ratingText: '[data-hook="acr-average-stars-rating-text"]',
  ratingAlt: '[data-hook="average-stars-rating-anywhere"]',
  reviewCount: '[data-hook="total-review-count"]',
} as const;

export function parseRatingPopoverHtml(html: string): OffscreenParseRatingResponse {
  if (typeof DOMParser === 'undefined') {
    return offscreenError(
      'PARSE_UNAVAILABLE',
      'DOMParser is not available in this context',
    );
  }

  if (!html || html.length > MAX_OFFSCREEN_HTML_LENGTH) {
    return offscreenError('HTML_TOO_LARGE', 'Response body is too large to parse');
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (error) {
    return offscreenError(
      'PARSE_FAILED',
      error instanceof Error ? error.message : 'Could not parse HTML',
    );
  }

  const ratingNode = doc.querySelector(ACR_SELECTORS.ratingText);
  const ratingAltNode = doc.querySelector(ACR_SELECTORS.ratingAlt);
  const countNode = doc.querySelector(ACR_SELECTORS.reviewCount);

  const ratingText =
    ratingNode?.textContent ??
    (ratingAltNode?.getAttribute('aria-label') || ratingAltNode?.getAttribute('title')) ??
    null;

  return {
    ok: true,
    rating: parseRating(ratingText),
    reviewCount: parseReviewCount(countNode?.textContent ?? null),
  };
}
