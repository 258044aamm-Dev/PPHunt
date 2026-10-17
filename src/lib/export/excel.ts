import { saveAs } from 'file-saver';
import * as XLSX from 'xlsx';
import type { Product } from '@/types/product';
import { neutralizeSpreadsheetFormula } from './sanitize';
import {
  DEFAULT_VISIBLE_COLUMNS,
  EXPORT_COLUMNS,
  sanitizeExportImageUrl,
} from './types';

const SHEET_NAME = 'Products';
const MIN_COL_WIDTH = 10;
const MAX_COL_WIDTH = 50;
const IMAGE_COL_WIDTH = 16;
const IMAGE_ROW_HEIGHT_PT = 48;
const HEADER_ROW_HEIGHT_PT = 22;
const DEFAULT_ROW_HEIGHT_PT = 20;
const IMAGE_FETCH_TIMEOUT_MS = 4000;
const IMAGE_FETCH_CONCURRENCY = 6;

// 44px thumbnail in English Metric Units (1px @ 96dpi = 9525 EMUs)
const THUMBNAIL_EXT_EMU = 44 * 9525; // 419100
const THUMBNAIL_OFFSET_EMU = 4 * 9525; // 38100

interface FetchedProductImage {
  rowIndex: number; // 0-based product index (1-based worksheet row index)
  colIndex: number; // 0-based column index
  asin: string;
  url: string;
  bytes: Uint8Array;
  extension: 'png' | 'jpg' | 'gif' | 'webp';
}

export type EmbedImagesMode = 'auto' | 'always' | 'never';

/**
 * M-6 (SAD-192) — decision D4 budgets for `embedImages: 'auto'`. All three
 * must hold; any breach degrades the remaining rows to URL text (the
 * fallback the exporter already writes for unavailable images).
 */
export const AUTO_MAX_PRODUCTS = 200;
export const AUTO_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const AUTO_MAX_WALL_MS = 20_000;

/**
 * Resolves whether images should be embedded at all, before any fetching.
 * 'auto' embeds only for small exports; the byte/time budgets are enforced
 * inside the fetch loop (a pre-computed estimate alone is not trusted).
 */
export function resolveEmbedImages(
  mode: EmbedImagesMode,
  productCount: number,
  maxProducts: number = AUTO_MAX_PRODUCTS
): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return productCount <= maxProducts;
}

export interface ExcelExportBuildOptions {
  /**
   * Custom image fetcher for unit testing or offline overrides.
   * Defaults to global `fetch` with timeout and `no-referrer`.
   */
  fetchImage?: (url: string) => Promise<{
    bytes: Uint8Array;
    contentType?: string | null;
  } | null>;
  /**
   * M-6 (SAD-192): 'auto' (default) embeds only within the D4 budgets,
   * 'always' embeds every image, 'never' skips fetching entirely and every
   * Image cell gets the URL text fallback.
   */
  embedImages?: EmbedImagesMode;
  /** Test seam to shrink the D4 budgets; production callers omit this. */
  budgets?: {
    maxProducts?: number;
    maxTotalBytes?: number;
    maxWallMs?: number;
  };
  /** Called after each image fetch settles (embedded, failed or skipped). */
  onProgress?: (fetched: number, total: number) => void;
}

/**
 * Detects image format ('png' | 'jpg' | 'gif' | 'webp') from magic bytes or MIME type.
 * Returns null if the payload is empty or not a valid raster image (e.g. an HTML 404 page).
 */
export function detectImageExtension(
  bytes: Uint8Array,
  contentType?: string | null
): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (!bytes || bytes.byteLength < 4) return null;

  // PNG: 89 50 4E 47
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  // GIF: 47 49 46 38 ("GIF8")
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'gif';
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }

  // Reject obvious HTML/XML/JSON error responses
  if (bytes[0] === 0x3c || bytes[0] === 0x7b) {
    return null;
  }

  if (contentType) {
    const lower = contentType.toLowerCase();
    if (lower.includes('image/png')) return 'png';
    if (lower.includes('image/jpeg') || lower.includes('image/jpg')) {
      return 'jpg';
    }
    if (lower.includes('image/gif')) return 'gif';
    if (lower.includes('image/webp')) return 'webp';
  }

  return null;
}

/**
 * Fetches or decodes a product image URL into raw bytes without throwing.
 * Returns null if the URL is missing, invalid, times out, or fails to load.
 */
async function defaultFetchProductImage(url: string): Promise<{
  bytes: Uint8Array;
  contentType?: string | null;
} | null> {
  const cleanUrl = sanitizeExportImageUrl(url);
  if (!cleanUrl) return null;

  // Support inline data:image/*;base64,... URLs directly in memory
  const dataMatch = cleanUrl.match(
    /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i
  );
  if (dataMatch) {
    try {
      const mime = dataMatch[1] ?? 'application/octet-stream';
      const base64 = (dataMatch[2] ?? '').replace(/\s+/g, '');
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return { bytes, contentType: mime };
    } catch {
      return null;
    }
  }

  if (typeof fetch !== 'function') return null;

  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(cleanUrl, {
      method: 'GET',
      referrerPolicy: 'no-referrer',
      signal: controller?.signal,
    });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const contentType = response.headers?.get?.('content-type') ?? null;
    return { bytes, contentType };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function encodeUtf8(xml: string): Uint8Array {
  return new TextEncoder().encode(xml);
}

function decodeUtf8(bytes: Uint8Array | number[]): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new TextDecoder('utf-8').decode(u8);
}

/**
 * Injects OpenXML DrawingML parts (`/xl/media/*`, `/xl/drawings/drawing1.xml`,
 * `/xl/drawings/_rels/drawing1.xml.rels`, `/xl/worksheets/_rels/sheet1.xml.rels`,
 * and `<drawing r:id="rId1"/>` in `/xl/worksheets/sheet1.xml`) into an `.xlsx`
 * ZIP buffer so embedded thumbnails render inside the `Image` column cells.
 */
function injectEmbeddedImagesIntoXlsxBuffer(
  xlsxBytes: Uint8Array,
  embeddedImages: FetchedProductImage[]
): Uint8Array {
  if (embeddedImages.length === 0) {
    return xlsxBytes;
  }

  const cfb = XLSX.CFB.read(xlsxBytes, { type: 'array' });
  const sheetEntry = XLSX.CFB.find(cfb, '/xl/worksheets/sheet1.xml');
  const contentTypesEntry = XLSX.CFB.find(cfb, '/[Content_Types].xml');

  if (!sheetEntry?.content || !contentTypesEntry?.content) {
    return xlsxBytes;
  }

  // 1. Add media files and build drawing1.xml + drawing1.xml.rels
  const relEntries: string[] = [];
  const anchorEntries: string[] = [];

  embeddedImages.forEach((img, idx) => {
    const mediaNum = idx + 1;
    const relId = `rId${mediaNum}`;
    const mediaFileName = `image${mediaNum}.${img.extension}`;
    const mediaPath = `/xl/media/${mediaFileName}`;

    XLSX.CFB.utils.cfb_add(cfb, mediaPath, img.bytes);

    relEntries.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaFileName}"/>`
    );

    // DrawingML 0-based coordinates: row 0 is header, so product at rowIndex is at rowIndex + 1
    const drawingCol = img.colIndex;
    const drawingRow = img.rowIndex + 1;
    const safeName = escapeXmlAttr(`Product ${img.asin || mediaNum}`);
    const safeDescr = escapeXmlAttr(img.url);

    anchorEntries.push(
      `<xdr:oneCellAnchor>` +
        `<xdr:from>` +
        `<xdr:col>${drawingCol}</xdr:col>` +
        `<xdr:colOff>${THUMBNAIL_OFFSET_EMU}</xdr:colOff>` +
        `<xdr:row>${drawingRow}</xdr:row>` +
        `<xdr:rowOff>${THUMBNAIL_OFFSET_EMU}</xdr:rowOff>` +
        `</xdr:from>` +
        `<xdr:ext cx="${THUMBNAIL_EXT_EMU}" cy="${THUMBNAIL_EXT_EMU}"/>` +
        `<xdr:pic>` +
        `<xdr:nvPicPr>` +
        `<xdr:cNvPr id="${mediaNum}" name="${safeName}" descr="${safeDescr}"/>` +
        `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>` +
        `</xdr:nvPicPr>` +
        `<xdr:blipFill>` +
        `<a:blip r:embed="${relId}"/>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
        `</xdr:blipFill>` +
        `<xdr:spPr>` +
        `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${THUMBNAIL_EXT_EMU}" cy="${THUMBNAIL_EXT_EMU}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
        `</xdr:spPr>` +
        `</xdr:pic>` +
        `<xdr:clientData/>` +
        `</xdr:oneCellAnchor>`
    );
  });

  const drawingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    anchorEntries.join('') +
    `</xdr:wsDr>`;

  const drawingRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    relEntries.join('') +
    `</Relationships>`;

  const sheetRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>` +
    `</Relationships>`;

  XLSX.CFB.utils.cfb_add(
    cfb,
    '/xl/drawings/drawing1.xml',
    encodeUtf8(drawingXml)
  );
  XLSX.CFB.utils.cfb_add(
    cfb,
    '/xl/drawings/_rels/drawing1.xml.rels',
    encodeUtf8(drawingRelsXml)
  );
  XLSX.CFB.utils.cfb_add(
    cfb,
    '/xl/worksheets/_rels/sheet1.xml.rels',
    encodeUtf8(sheetRelsXml)
  );

  // 2. Link <drawing r:id="rId1"/> inside /xl/worksheets/sheet1.xml
  const currentSheetXml = decodeUtf8(sheetEntry.content as Uint8Array);
  if (!currentSheetXml.includes('<drawing ')) {
    const updatedSheetXml = currentSheetXml.replace(
      '</worksheet>',
      '<drawing r:id="rId1"/></worksheet>'
    );
    sheetEntry.content = encodeUtf8(updatedSheetXml);
  }

  // 3. Register /xl/drawings/drawing1.xml and webp content type in /[Content_Types].xml
  let currentCtXml = decodeUtf8(contentTypesEntry.content as Uint8Array);
  if (!currentCtXml.includes('Extension="webp"')) {
    currentCtXml = currentCtXml.replace(
      '</Types>',
      '<Default Extension="webp" ContentType="image/webp"/></Types>'
    );
  }
  if (!currentCtXml.includes('/xl/drawings/drawing1.xml')) {
    currentCtXml = currentCtXml.replace(
      '</Types>',
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'
    );
  }
  contentTypesEntry.content = encodeUtf8(currentCtXml);

  const out = XLSX.CFB.write(cfb, { fileType: 'zip', type: 'array' });
  return new Uint8Array(out);
}

/**
 * Builds the `.xlsx` workbook binary buffer for the given products and columns.
 *
 * - Includes the `Image` column whenever selected (enabled by default).
 * - Embeds fetched product image thumbnails directly into the `Image` column cells
 *   via OpenXML DrawingML (`/xl/media/*` + `/xl/drawings/drawing1.xml`).
 * - Automatically falls back to writing the image URL text in the cell when an image
 *   cannot be fetched, and writes an empty cell when `imageUrl` is missing or invalid,
 *   never interrupting the export process (SAD-139).
 */
export async function buildExcelWorkbookBuffer(
  products: Product[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  options: ExcelExportBuildOptions = {}
): Promise<Uint8Array> {
  const requested =
    visibleColumns && visibleColumns.length > 0
      ? visibleColumns
      : DEFAULT_VISIBLE_COLUMNS;
  const columns = requested.filter((col) => col in EXPORT_COLUMNS);
  const imageColIdx = columns.indexOf('Image');
  const fetcher = options.fetchImage ?? defaultFetchProductImage;

  // Attempt to fetch images concurrently in bounded batches when the Image
  // column is included AND the embed mode allows it (M-6 / SAD-192).
  const embeddedByRow = new Map<number, FetchedProductImage>();
  const embedMode: EmbedImagesMode = options.embedImages ?? 'auto';
  const maxProducts = options.budgets?.maxProducts ?? AUTO_MAX_PRODUCTS;
  const maxTotalBytes = options.budgets?.maxTotalBytes ?? AUTO_MAX_TOTAL_BYTES;
  const maxWallMs = options.budgets?.maxWallMs ?? AUTO_MAX_WALL_MS;

  if (
    imageColIdx >= 0 &&
    products.length > 0 &&
    resolveEmbedImages(embedMode, products.length, maxProducts)
  ) {
    const isAuto = embedMode === 'auto';
    const startedAt = Date.now();
    // Running total over REAL fetched bytes is the primary size defence;
    // a pre-fetch estimate is never trusted on its own (SAD-192).
    let totalBytes = 0;
    let settled = 0;
    let budgetExhausted = false;

    const queue = products.map((product, rowIndex) => ({
      product,
      rowIndex,
      url: sanitizeExportImageUrl(product.imageUrl),
    }));

    const fetchWithDeadline = (url: string, deadlineMs: number | null) => {
      const pending = fetcher(url);
      if (deadlineMs === null) return pending;
      // Auto mode only: cap each fetch by the remaining wall budget so a
      // stalled image server cannot outlast the export.
      return Promise.race([
        pending,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), Math.max(50, deadlineMs))
        ),
      ]);
    };

    for (let i = 0; i < queue.length && !budgetExhausted; i += IMAGE_FETCH_CONCURRENCY) {
      const batch = queue.slice(i, i + IMAGE_FETCH_CONCURRENCY);
      await Promise.all(
        batch.map(async (item) => {
          try {
            if (budgetExhausted || !item.url) return;
            const remainingMs = isAuto
              ? maxWallMs - (Date.now() - startedAt)
              : null;
            if (isAuto && remainingMs !== null && remainingMs <= 0) {
              budgetExhausted = true;
              return;
            }
            const res = await fetchWithDeadline(item.url, remainingMs);
            if (!res?.bytes) return;
            // Check budgets BEFORE committing the bytes to the workbook.
            if (isAuto && totalBytes + res.bytes.length > maxTotalBytes) {
              budgetExhausted = true;
              return;
            }
            if (isAuto && Date.now() - startedAt > maxWallMs) {
              budgetExhausted = true;
              return;
            }
            const ext = detectImageExtension(res.bytes, res.contentType);
            if (!ext) return;
            totalBytes += res.bytes.length;
            embeddedByRow.set(item.rowIndex, {
              rowIndex: item.rowIndex,
              colIndex: imageColIdx,
              asin: item.product.asin,
              url: item.url,
              bytes: res.bytes,
              extension: ext,
            });
          } catch {
            // Gracefully fall back to URL text in the cell
          } finally {
            settled += 1;
            options.onProgress?.(settled, queue.length);
          }
        })
      );
      if (isAuto && Date.now() - startedAt > maxWallMs) {
        budgetExhausted = true;
      }
    }
  }

  // Build header row
  const headerRow = columns.map((col) => col);

  // Build data rows
  const dataRows = products.map((product) => {
    return columns.map((col) => {
      const accessor = EXPORT_COLUMNS[col];
      let value: string | number | null;

      if (typeof accessor === 'function') {
        value = accessor(product);
      } else if (accessor) {
        const raw = product[accessor];
        value = raw == null ? null : String(raw);
      } else {
        value = null;
      }

      if (col === 'Price' && product.price != null) {
        return product.price;
      }
      if (col === 'List Price' && product.listPrice != null) {
        return product.listPrice;
      }
      if (col === 'Rating' && product.rating != null) {
        return product.rating;
      }
      if (col === 'Reviews' && product.reviewCount != null) {
        return product.reviewCount;
      }

      if (col === 'Collected At' && value) {
        try {
          return new Date(value).toLocaleString();
        } catch {
          return value;
        }
      }

      // H-6: string cells only — the numeric early-returns above keep
      // Price/List Price/Rating/Reviews real numbers (sortable, summable).
      // Belt-and-braces for SheetJS; load-bearing for the Phase 8 exceljs
      // engine, which interprets a leading '=' as a formula.
      return typeof value === 'string'
        ? neutralizeSpreadsheetFormula(value)
        : (value ?? '');
    });
  });

  // Create worksheet
  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);

  // Bold headers
  headerRow.forEach((_, colIdx) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    if (ws[cellRef]) {
      ws[cellRef].s = { font: { bold: true } };
    }
  });

  // Set row heights so embedded 44x44px thumbnails fit cleanly inside their cells
  ws['!rows'] = [
    { hpt: HEADER_ROW_HEIGHT_PT },
    ...products.map((_, rowIdx) => ({
      hpt: embeddedByRow.has(rowIdx)
        ? IMAGE_ROW_HEIGHT_PT
        : DEFAULT_ROW_HEIGHT_PT,
    })),
  ];

  // Auto-size columns (keep Image column compact when images are embedded)
  ws['!cols'] = columns.map((col, colIdx) => {
    if (col === 'Image' && embeddedByRow.size > 0) {
      return { wch: IMAGE_COL_WIDTH };
    }
    let maxLen = col.length;
    dataRows.forEach((row) => {
      const cellVal = row[colIdx];
      const len = cellVal != null ? String(cellVal).length : 0;
      if (len > maxLen) maxLen = len;
    });
    return {
      wch: Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, maxLen + 2)),
    };
  });

  // Create workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);

  const rawBuffer = new Uint8Array(
    XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  );

  const embeddedList = Array.from(embeddedByRow.values()).sort(
    (a, b) => a.rowIndex - b.rowIndex
  );
  return injectEmbeddedImagesIntoXlsxBuffer(rawBuffer, embeddedList);
}

/**
 * Exports products as an Excel (.xlsx) file with embedded product image thumbnails
 * in the `Image` column and automatic URL fallback when an image is unavailable.
 */
export async function exportExcel(
  products: Product[],
  visibleColumns: string[],
  filename: string,
  options?: ExcelExportBuildOptions
): Promise<void> {
  const xlsxBytes = await buildExcelWorkbookBuffer(
    products,
    visibleColumns,
    options
  );
  // TS 5.7+ distinguishes Uint8Array<ArrayBufferLike> from BlobPart; copying
  // into a fresh ArrayBuffer-backed view keeps the export path cast-free.
  const blob = new Blob([new Uint8Array(xlsxBytes)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  saveAs(blob, `${filename}.xlsx`);
}
