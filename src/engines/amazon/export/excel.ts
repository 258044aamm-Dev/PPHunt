import { saveAs } from 'file-saver';
import * as XLSX from 'xlsx';
import type { AmazonProduct } from '../types/product';
import { neutralizeSpreadsheetFormula } from './sanitize';
import {
  DEFAULT_VISIBLE_COLUMNS,
  EXPORT_COLUMNS,
  buildExportFilename,
  resolveExportColumns,
  sanitizeExportImageUrl,
} from './types';

export type EmbedImagesMode = 'auto' | 'always' | 'never';

export interface ImageEmbedBudgets {
  maxProducts?: number;
  maxTotalBytes?: number;
  maxWallMs?: number;
}

export interface ExcelExportBuildOptions {
  embedImages?: EmbedImagesMode;
  budgets?: ImageEmbedBudgets;
  fetchImage?: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; contentType?: string | null } | null>;
  onProgress?: (fetched: number, total: number) => void;
}

const SHEET_NAME = 'Products';
const MIN_COL_WIDTH = 10;
const MAX_COL_WIDTH = 50;
const IMAGE_COL_WIDTH = 16;
const IMAGE_ROW_HEIGHT_PT = 48;
const HEADER_ROW_HEIGHT_PT = 22;
const DEFAULT_ROW_HEIGHT_PT = 20;
const IMAGE_FETCH_TIMEOUT_MS = 4000;
const IMAGE_FETCH_CONCURRENCY = 6;

export const AUTO_MAX_PRODUCTS = 200;
export const AUTO_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const AUTO_MAX_WALL_MS = 20_000;

const THUMBNAIL_EXT_EMU = 44 * 9525;
const THUMBNAIL_OFFSET_EMU = 4 * 9525;

interface FetchedProductImage {
  rowIndex: number;
  colIndex: number;
  asin: string;
  url: string;
  bytes: Uint8Array;
  extension: 'png' | 'jpg' | 'gif' | 'webp';
}

/**
 * Decides whether `.xlsx` export should attempt to fetch and embed product images
 * based on `embedImages` mode (`'auto' | 'always' | 'never'`) and product count.
 */
export function resolveEmbedImages(
  mode: EmbedImagesMode = 'auto',
  productCount: number,
  maxProducts: number = AUTO_MAX_PRODUCTS,
): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return productCount <= maxProducts;
}

/**
 * Detects the image file extension (`png`, `jpg`, `gif`, `webp`) from magic bytes
 * or HTTP `Content-Type` header.
 */
export function detectImageExtension(
  bytes: Uint8Array,
  contentType?: string | null,
): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (bytes.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
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
    // GIF: 47 49 46 38
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return 'gif';
    }
    // WEBP: RIFF....WEBP
    if (
      bytes.length >= 12 &&
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
  }

  if (contentType) {
    const lower = contentType.toLowerCase();
    if (lower.includes('png')) return 'png';
    if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
    if (lower.includes('gif')) return 'gif';
    if (lower.includes('webp')) return 'webp';
  }

  return null;
}

async function defaultFetchProductImage(url: string): Promise<{
  bytes: Uint8Array;
  contentType?: string | null;
} | null> {
  const cleanUrl = sanitizeExportImageUrl(url);
  if (!cleanUrl) return null;

  const dataMatch = cleanUrl.match(
    /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i,
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

function injectEmbeddedImagesIntoXlsxBuffer(
  xlsxBytes: Uint8Array,
  embeddedImages: FetchedProductImage[],
): Uint8Array {
  if (embeddedImages.length === 0) return xlsxBytes;

  const cfb = XLSX.CFB.read(xlsxBytes, { type: 'array' });
  const sheetEntry = XLSX.CFB.find(cfb, '/xl/worksheets/sheet1.xml');
  const contentTypesEntry = XLSX.CFB.find(cfb, '/[Content_Types].xml');

  if (!sheetEntry?.content || !contentTypesEntry?.content) {
    return xlsxBytes;
  }

  const relEntries: string[] = [];
  const anchorEntries: string[] = [];

  embeddedImages.forEach((img, idx) => {
    const mediaNum = idx + 1;
    const relId = `rId${mediaNum}`;
    const mediaFileName = `image${mediaNum}.${img.extension}`;
    const mediaPath = `/xl/media/${mediaFileName}`;

    XLSX.CFB.utils.cfb_add(cfb, mediaPath, img.bytes);

    relEntries.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaFileName}"/>`,
    );

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
        `</xdr:oneCellAnchor>`,
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
    encodeUtf8(drawingXml),
  );
  XLSX.CFB.utils.cfb_add(
    cfb,
    '/xl/drawings/_rels/drawing1.xml.rels',
    encodeUtf8(drawingRelsXml),
  );
  XLSX.CFB.utils.cfb_add(
    cfb,
    '/xl/worksheets/_rels/sheet1.xml.rels',
    encodeUtf8(sheetRelsXml),
  );

  const currentSheetXml = decodeUtf8(sheetEntry.content as Uint8Array);
  if (!currentSheetXml.includes('<drawing ')) {
    const updatedSheetXml = currentSheetXml.replace(
      '</worksheet>',
      '<drawing r:id="rId1"/></worksheet>',
    );
    sheetEntry.content = encodeUtf8(updatedSheetXml);
  }

  let currentCtXml = decodeUtf8(contentTypesEntry.content as Uint8Array);
  if (!currentCtXml.includes('Extension="webp"')) {
    currentCtXml = currentCtXml.replace(
      '</Types>',
      '<Default Extension="webp" ContentType="image/webp"/></Types>',
    );
  }
  if (!currentCtXml.includes('/xl/drawings/drawing1.xml')) {
    currentCtXml = currentCtXml.replace(
      '</Types>',
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>',
    );
  }
  contentTypesEntry.content = encodeUtf8(currentCtXml);

  const out = XLSX.CFB.write(cfb, { fileType: 'zip', type: 'array' });
  return new Uint8Array(out);
}

/**
 * Builds the `.xlsx` workbook binary buffer for Amazon products.
 */
export async function buildExcelWorkbookBuffer(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  options: ExcelExportBuildOptions = {},
): Promise<Uint8Array> {
  const columns = resolveExportColumns(visibleColumns);
  const imageColIdx = columns.indexOf('Image');
  const fetcher = options.fetchImage ?? defaultFetchProductImage;

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
      return Promise.race([
        pending,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), Math.max(50, deadlineMs)),
        ),
      ]);
    };

    for (
      let i = 0;
      i < queue.length && !budgetExhausted;
      i += IMAGE_FETCH_CONCURRENCY
    ) {
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
            // Fall back to URL text
          } finally {
            settled += 1;
            options.onProgress?.(settled, queue.length);
          }
        }),
      );
      if (isAuto && Date.now() - startedAt > maxWallMs) {
        budgetExhausted = true;
      }
    }
  }

  const headerRow = columns.map((col) => col);

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

      return typeof value === 'string'
        ? neutralizeSpreadsheetFormula(value)
        : (value ?? '');
    });
  });

  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);

  headerRow.forEach((_, colIdx) => {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    if (ws[cellRef]) {
      ws[cellRef].s = { font: { bold: true } };
    }
  });

  ws['!rows'] = [
    { hpt: HEADER_ROW_HEIGHT_PT },
    ...products.map((_, rowIdx) => ({
      hpt: embeddedByRow.has(rowIdx)
        ? IMAGE_ROW_HEIGHT_PT
        : DEFAULT_ROW_HEIGHT_PT,
    })),
  ];

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

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);

  const rawBuffer = new Uint8Array(
    XLSX.write(wb, { bookType: 'xlsx', type: 'array' }),
  );

  const embeddedList = Array.from(embeddedByRow.values()).sort(
    (a, b) => a.rowIndex - b.rowIndex,
  );
  return injectEmbeddedImagesIntoXlsxBuffer(rawBuffer, embeddedList);
}

/**
 * Exports Amazon products as an `.xlsx` file (`pphunt-amazon-YYYY-MM-DD-NNN.xlsx`).
 */
export async function exportExcel(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  filename: string = buildExportFilename(products.length),
  options?: ExcelExportBuildOptions,
): Promise<void> {
  const xlsxBytes = await buildExcelWorkbookBuffer(
    products,
    visibleColumns,
    options,
  );
  const blob = new Blob([new Uint8Array(xlsxBytes)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const cleanName = filename.replace(/\.xlsx$/i, '');
  saveAs(blob, `${cleanName}.xlsx`);
}
