import { validateAndNormalizeScrapedProduct } from '../scraper/field-parsers';
import { parseAmazonProductDetail } from '../scraper/product-detail';
import { normalizeASIN } from '../utils/amazon-url';
import type { ScrapedProduct } from '../types';
import {
  MAX_OFFSCREEN_HTML_LENGTH,
  offscreenError,
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

  const parsed = parseAmazonProductDetail(doc, productUrl);
  if (!parsed) {
    return offscreenError('PARSE_FAILED', 'No product found on the fetched page');
  }

  const normalized = validateAndNormalizeScrapedProduct(parsed, productUrl);
  if (!normalized) {
    return offscreenError('PARSER_REJECTED', 'Parsed product failed validation');
  }

  if (expectedAsin) {
    const wanted = normalizeASIN(expectedAsin);
    const got = normalizeASIN(normalized.asin);
    if (!got || got !== wanted) {
      // A variant redirect or an interstitial resolves to a different product.
      // Reporting it as this ASIN's details would silently corrupt the row.
      return offscreenError(
        'PARSER_REJECTED',
        `Page resolved to ${normalized.asin || 'no ASIN'}, expected ${expectedAsin}`,
      );
    }
  }

  return { ok: true, product: normalized as ScrapedProduct };
}
