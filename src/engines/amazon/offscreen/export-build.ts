import { buildAmazonCSVContent } from '../export/csv';
import { buildExcelWorkbookBuffer } from '../export/excel';
import type { AmazonProduct } from '../types/product';
import {
  MAX_OFFSCREEN_BLOB_BYTES,
  offscreenError,
  type OffscreenBuildExportRequest,
  type OffscreenBuildExportResponse,
} from './protocol';

/**
 * SAD-290 (plan 11.1-11.2): turn one collection into downloadable bytes.
 *
 * The offscreen document is used for exactly one reason: it owns the DOM APIs a
 * service worker lacks. The *formatting* is not reimplemented here - the CSV and
 * XLSX writers in `export/` are called as-is, so a quick-save export and a panel
 * export of the same rows are byte-identical. What this module adds is the
 * transport shape the service worker can carry over `runtime.sendMessage`
 * (base64 + mime + filename) and the size guard that keeps a runaway collection
 * from allocating gigabytes inside an extension page.
 */

export const EXPORT_MIME_TYPES = {
  csv: 'text/csv;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/** Chunk size keeps `String.fromCharCode` well below the argument-list limit. */
const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  // jsdom-less fallback: the CSV writer already produced a JS string, and every
  // byte it can contain is representable here.
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export interface BuildExportDeps {
  /** Injectable so tests can assert the image budget without a network. */
  fetchImage?: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; contentType?: string | null } | null>;
}

/**
 * Builds the file. Returns base64 rather than a blob URL because the caller (the
 * service worker) is the one that decides when a download starts; the existing
 * `OFFSCREEN_CREATE_BLOB_URL` request mints the URL when that time comes.
 */
export async function buildExportFile(
  request: OffscreenBuildExportRequest,
  deps: BuildExportDeps = {},
): Promise<OffscreenBuildExportResponse> {
  const products = request.products as AmazonProduct[];
  const extension = request.format === 'csv' ? 'csv' : 'xlsx';
  const filename = `${request.filename}.${extension}`;
  const mimeType = EXPORT_MIME_TYPES[request.format];

  let bytes: Uint8Array;
  try {
    if (request.format === 'csv') {
      bytes = utf8Bytes(
        buildAmazonCSVContent(products, request.columns, request.includeBOM),
      );
    } else {
      bytes = await buildExcelWorkbookBuffer(products, request.columns, {
        embedImages: request.embedImages,
        ...(deps.fetchImage ? { fetchImage: deps.fetchImage } : {}),
      });
    }
  } catch (error) {
    return offscreenError(
      'EXPORT_BUILD_FAILED',
      error instanceof Error ? error.message : 'Could not build the export',
    );
  }

  if (bytes.byteLength > MAX_OFFSCREEN_BLOB_BYTES) {
    return offscreenError(
      'EXPORT_TOO_LARGE',
      `Export is ${bytes.byteLength} bytes, over the ${
        MAX_OFFSCREEN_BLOB_BYTES / (1024 * 1024)
      } MB budget`,
    );
  }

  return {
    ok: true,
    base64: bytesToBase64(bytes),
    mimeType,
    filename,
    byteLength: bytes.byteLength,
    count: products.length,
  };
}
