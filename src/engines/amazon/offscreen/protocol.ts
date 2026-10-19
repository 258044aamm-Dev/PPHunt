/**
 * SAD-295 (plan 10.2): the wire format between the service worker and the
 * offscreen document.
 *
 * The offscreen document is the only MV3 context with `DOMParser` and
 * `URL.createObjectURL`, and `runtime` is the only extension API it may use - so
 * every request is a plain JSON object with an explicit `target` so unrelated
 * `runtime.onMessage` listeners (content scripts, panel, popup) ignore it.
 *
 * Validation is hand-written rather than Zod: this module is on the service
 * worker's hot path and the schema is three flat objects. Anything that fails a
 * guard is treated as "not ours" (`isOffscreenRequest` returns false) so the
 * listener can decline the message instead of answering with an error the
 * caller cannot attribute.
 */

export const OFFSCREEN_TARGET = 'pphunt-offscreen';
export const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/** A fetched PDP is ~1-2 MB. Anything past this is a runaway download, not a page. */
export const MAX_OFFSCREEN_HTML_LENGTH = 5_000_000;
/** Exports are built in memory in the offscreen document; keep it bounded. */
export const MAX_OFFSCREEN_BLOB_BYTES = 32 * 1024 * 1024;

export type OffscreenRequestType =
  | 'OFFSCREEN_PARSE_PRODUCT'
  | 'OFFSCREEN_CREATE_BLOB_URL'
  | 'OFFSCREEN_REVOKE_URL';

export interface OffscreenParseProductRequest {
  target: typeof OFFSCREEN_TARGET;
  type: 'OFFSCREEN_PARSE_PRODUCT';
  html: string;
  productUrl: string;
  /** When present, the parsed product must resolve to this ASIN. */
  asin?: string;
}

export interface OffscreenCreateBlobUrlRequest {
  target: typeof OFFSCREEN_TARGET;
  type: 'OFFSCREEN_CREATE_BLOB_URL';
  mimeType: string;
  base64: string;
}

export interface OffscreenRevokeUrlRequest {
  target: typeof OFFSCREEN_TARGET;
  type: 'OFFSCREEN_REVOKE_URL';
  url: string;
}

export type OffscreenRequest =
  | OffscreenParseProductRequest
  | OffscreenCreateBlobUrlRequest
  | OffscreenRevokeUrlRequest;

export type OffscreenErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_TYPE'
  | 'HTML_TOO_LARGE'
  | 'PARSE_UNAVAILABLE'
  | 'PARSE_FAILED'
  | 'PARSER_REJECTED'
  | 'BLOB_TOO_LARGE'
  | 'BLOB_FAILED';

export interface OffscreenError {
  ok: false;
  code: OffscreenErrorCode;
  message: string;
}

export interface OffscreenParseSuccess {
  ok: true;
  product: import('../types').ScrapedProduct;
}

export interface OffscreenBlobSuccess {
  ok: true;
  url: string;
  size: number;
}

export interface OffscreenRevokeSuccess {
  ok: true;
}

export type OffscreenParseResponse = OffscreenParseSuccess | OffscreenError;
export type OffscreenBlobResponse = OffscreenBlobSuccess | OffscreenError;
export type OffscreenRevokeResponse = OffscreenRevokeSuccess | OffscreenError;

export type OffscreenResponse =
  | OffscreenParseResponse
  | OffscreenBlobResponse
  | OffscreenRevokeResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True only for a well formed request addressed to the offscreen document.
 * A malformed offscreen message is *not* announced as invalid: the listener
 * returns false and leaves it to whoever sent it to time out, exactly like any
 * other `runtime` message this document does not own.
 */
export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (!isRecord(value)) return false;
  if (value.target !== OFFSCREEN_TARGET) return false;

  switch (value.type) {
    case 'OFFSCREEN_PARSE_PRODUCT':
      return (
        typeof value.html === 'string' &&
        value.html.length > 0 &&
        value.html.length <= MAX_OFFSCREEN_HTML_LENGTH &&
        typeof value.productUrl === 'string' &&
        value.productUrl.length > 0 &&
        (value.asin === undefined || typeof value.asin === 'string')
      );

    case 'OFFSCREEN_CREATE_BLOB_URL':
      return (
        typeof value.mimeType === 'string' &&
        value.mimeType.length > 0 &&
        typeof value.base64 === 'string' &&
        value.base64.length > 0 &&
        value.base64.length <= MAX_OFFSCREEN_BLOB_BYTES
      );

    case 'OFFSCREEN_REVOKE_URL':
      return typeof value.url === 'string' && value.url.startsWith('blob:');

    default:
      return false;
  }
}

export function offscreenError(
  code: OffscreenErrorCode,
  message: string,
): OffscreenError {
  return { ok: false, code, message };
}
