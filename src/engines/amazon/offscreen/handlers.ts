import {
  MAX_OFFSCREEN_BLOB_BYTES,
  OFFSCREEN_TARGET,
  offscreenError,
  type OffscreenBlobResponse,
  type OffscreenRequest,
  type OffscreenResponse,
  type OffscreenRevokeResponse,
} from './protocol';
import { buildExportFile } from './export-build';
import { parsePdpHtml } from './parse';

/**
 * SAD-295: the offscreen document's request dispatcher.
 *
 * Only `runtime` is available here (plan 10.2), so this module keeps its own
 * bookkeeping of the blob URLs it minted: `URL.revokeObjectURL` needs the exact
 * string, and the service worker that asked for it cannot enumerate them.
 */

const objectUrls = new Set<string>();

/** Split out so the budget boundary can be tested without allocating 32 MB. */
export function exceedsByteBudget(
  size: number,
  max: number = MAX_OFFSCREEN_BLOB_BYTES,
): boolean {
  return size > max;
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function createBlobUrl(
  mimeType: string,
  base64: string,
): OffscreenBlobResponse {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return offscreenError('BLOB_FAILED', 'URL.createObjectURL is unavailable');
  }

  const bytes = base64ToBytes(base64);
  if (!bytes) {
    return offscreenError('BLOB_FAILED', 'Payload is not valid base64');
  }

  if (exceedsByteBudget(bytes.byteLength)) {
    return offscreenError('BLOB_TOO_LARGE', 'Export is too large to build');
  }

  try {
    // Copy into a plain ArrayBuffer: `Uint8Array<ArrayBufferLike>` is not a
    // BlobPart in TS's DOM lib when the buffer could be shared.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
    objectUrls.add(url);
    return { ok: true, url, size: bytes.byteLength };
  } catch (error) {
    return offscreenError(
      'BLOB_FAILED',
      error instanceof Error ? error.message : 'Could not create a blob URL',
    );
  }
}

export function revokeBlobUrl(url: string): OffscreenRevokeResponse {
  if (!objectUrls.has(url)) {
    // Revoking an unknown URL is not a failure: the service worker may retry
    // after a restart, and a second revoke must stay harmless.
    return { ok: true };
  }

  try {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
    return { ok: true };
  } catch (error) {
    return offscreenError(
      'BLOB_FAILED',
      error instanceof Error ? error.message : 'Could not revoke the URL',
    );
  }
}

export function revokeAllBlobUrls(): void {
  for (const url of objectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Best effort on teardown.
    }
  }
  objectUrls.clear();
}

export function liveBlobUrlCount(): number {
  return objectUrls.size;
}

export async function handleOffscreenRequest(
  request: OffscreenRequest,
): Promise<OffscreenResponse> {
  switch (request.type) {
    case 'OFFSCREEN_PARSE_PRODUCT':
      // Synchronous parse, but the listener contract is a promise either way.
      return parsePdpHtml(request.html, request.productUrl, request.asin);

    case 'OFFSCREEN_CREATE_BLOB_URL':
      return createBlobUrl(request.mimeType, request.base64);

    case 'OFFSCREEN_REVOKE_URL':
      return revokeBlobUrl(request.url);

    case 'OFFSCREEN_BUILD_EXPORT':
      // SAD-290: bytes only; the worker decides when a download starts.
      return buildExportFile(request);

    default:
      return offscreenError('UNKNOWN_TYPE', 'Unsupported offscreen request');
  }
}

export interface OffscreenMessageListener {
  (message: unknown, sender: unknown, sendResponse?: (response: unknown) => void): boolean;
}

/**
 * The `runtime.onMessage` listener the entrypoint registers.
 *
 * Returns `false` for anything not addressed to this document so other
 * listeners (content scripts, panel) still see it, and `true` when it will
 * answer asynchronously.
 */
export function createOffscreenMessageHandler(): OffscreenMessageListener {
  return (message, _sender, sendResponse) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      (message as { target?: unknown }).target !== OFFSCREEN_TARGET
    ) {
      return false;
    }

    const request = message as OffscreenRequest;
    const respond = (response: OffscreenResponse) => {
      try {
        sendResponse?.(response);
      } catch {
        // The caller went away (tab closed, worker restarted). Nothing to do.
      }
    };

    void handleOffscreenRequest(request)
      .then(respond)
      .catch((error: unknown) =>
        respond(
          offscreenError(
            'UNKNOWN_TYPE',
            error instanceof Error ? error.message : 'Offscreen handler failed',
          ),
        ),
      );

    return true;
  };
}
