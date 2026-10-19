import { getSettings } from '../db';
import { db } from '../db/database';
import { buildCollectionExportFilename } from '../export/filename';
import { getExportColumnsFromSettings } from '../export/types';
import type { AmazonProduct } from '../types/product';
import type { AmazonSettings } from '../types';
import { buildExportViaOffscreen } from './offscreen';
import type { OffscreenBuildExportResponse } from '../offscreen/protocol';

/**
 * SAD-290 (plan 11.1): the collection half of the export.
 *
 * Two decisions live here:
 *
 * 1. **Reads stay in the service worker.** The offscreen document could open the
 *    same Dexie database, but a second long-lived connection is a liability: a
 *    future schema upgrade blocks while it is open, and the panel's live queries
 *    would start observing a context the user cannot see. The worker loads the
 *    rows and hands plain objects across `runtime.sendMessage`.
 * 2. **Only what is stored is exported.** A missing price is `''`, not `'—'` or
 *    `'N/A'`; the snapshot columns are counts and timestamps that actually exist.
 *    Nothing in this path fills a field the collection does not have.
 */

/** Columns only the collection export has; the panel export is unchanged. */
export const COLLECTION_EXPORT_EXTRA_COLUMNS = [
  'Snapshot Count',
  'Last Snapshot',
] as const;

export interface ExportRow extends AmazonProduct {
  snapshotCount: number;
  lastSnapshotAt: string | null;
}

export type CollectionExportFormat = 'csv' | 'xlsx';

export async function loadCollectionForExport(
  sessionKey: string,
): Promise<ExportRow[]> {
  const [products, snapshots] = await Promise.all([
    db.products.where('sessionKey').equals(sessionKey).toArray(),
    db.snapshots.where('sessionKey').equals(sessionKey).toArray(),
  ]);

  const stats = new Map<string, { count: number; last: string | null }>();
  for (const snapshot of snapshots) {
    const current = stats.get(snapshot.asin) ?? { count: 0, last: null };
    const capturedAt = snapshot.capturedAt ?? null;
    stats.set(snapshot.asin, {
      count: current.count + 1,
      last:
        capturedAt && (!current.last || capturedAt > current.last)
          ? capturedAt
          : current.last,
    });
  }

  return products
    .slice()
    .sort((a, b) => (a.collectedAt ?? '').localeCompare(b.collectedAt ?? ''))
    .map((product) => {
      const stat = stats.get(product.asin);
      return {
        ...product,
        snapshotCount: stat?.count ?? 0,
        lastSnapshotAt: stat?.last ?? null,
      };
    });
}

export interface BuildCollectionExportInput {
  sessionKey: string;
  format: CollectionExportFormat;
  /** Collection label, used only for the filename slug. */
  label?: string | null;
  date?: Date;
  includeBOM?: boolean;
  embedImages?: 'auto' | 'always' | 'never';
  /** Overrides the settings-derived column list (tests, future column picker). */
  columns?: string[];
}

export type CollectionExportErrorCode =
  | 'EXPORT_INVALID'
  | 'EXPORT_BUILD_FAILED'
  | 'EXPORT_TOO_LARGE'
  | 'DB_READ_FAILED';

export type BuildCollectionExportResult =
  | {
      ok: true;
      filename: string;
      base64: string;
      mimeType: string;
      byteLength: number;
      count: number;
    }
  | { ok: false; code: CollectionExportErrorCode; message: string };

export interface BuildCollectionExportDeps {
  load?: (sessionKey: string) => Promise<ExportRow[]>;
  send?: (input: {
    format: CollectionExportFormat;
    products: ExportRow[];
    columns: string[];
    filename: string;
    includeBOM: boolean;
    embedImages: 'auto' | 'always' | 'never';
  }) => Promise<OffscreenBuildExportResponse>;
  settings?: AmazonSettings;
}

/**
 * Builds the file for one collection. No download, no blob URL, no DOM: the
 * caller (SAD-291's export service) decides when and how to deliver the bytes.
 */
export async function buildCollectionExport(
  input: BuildCollectionExportInput,
  deps: BuildCollectionExportDeps = {},
): Promise<BuildCollectionExportResult> {
  let rows: ExportRow[];
  try {
    rows = await (deps.load ?? loadCollectionForExport)(input.sessionKey);
  } catch (error) {
    return {
      ok: false,
      code: 'DB_READ_FAILED',
      message:
        error instanceof Error
          ? `Could not read this collection: ${error.message}`
          : 'Could not read this collection',
    };
  }

  if (rows.length === 0) {
    return {
      ok: false,
      code: 'EXPORT_INVALID',
      message: 'This collection has no products to export',
    };
  }

  const settings = deps.settings ?? (await getSettings());
  const columns =
    input.columns ??
    [
      ...getExportColumnsFromSettings(settings.enabledFields),
      ...COLLECTION_EXPORT_EXTRA_COLUMNS,
    ];

  const filename = buildCollectionExportFilename({
    label: input.label,
    count: rows.length,
    date: input.date ?? new Date(),
    prefix: settings.exportFilename,
  });

  const send = deps.send ?? buildExportViaOffscreen;
  let response: OffscreenBuildExportResponse;
  try {
    response = await send({
      format: input.format,
      products: rows,
      columns,
      filename,
      includeBOM: input.includeBOM ?? settings.includeBOM,
      embedImages: input.embedImages ?? settings.exportImages,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'EXPORT_BUILD_FAILED',
      message:
        error instanceof Error ? error.message : 'Could not build the export',
    };
  }

  if (!response.ok) {
    // Normalize the transport's taxonomy: a caller only needs to distinguish
    // "too big" and "nothing to export" from "the build failed".
    const code: CollectionExportErrorCode =
      response.code === 'EXPORT_TOO_LARGE' || response.code === 'EXPORT_INVALID'
        ? response.code
        : 'EXPORT_BUILD_FAILED';
    return { ok: false, code, message: response.message };
  }

  return {
    ok: true,
    filename: response.filename,
    base64: response.base64,
    mimeType: response.mimeType,
    byteLength: response.byteLength,
    count: response.count,
  };
}
