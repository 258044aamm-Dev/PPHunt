import { getSettings } from '../db';
import { readOneClickCollection } from '../db/one-click-state';
import type { OffscreenBlobResponse, OffscreenRevokeResponse } from '../offscreen/protocol';
import type { AmazonSettings, ExportFormat } from '../types';
import {
  buildCollectionExport,
  type BuildCollectionExportResult,
  type CollectionExportErrorCode,
  type CollectionExportFormat,
} from './export-collection';
import { saveJobStore } from './job-store';
import { createBlobUrlViaOffscreen, revokeBlobUrlViaOffscreen } from './offscreen';

/**
 * SAD-291 (plan 11.2): the single place a file becomes a download.
 *
 * Everything above this module produces bytes and a filename; everything below
 * is one function, `downloadOnce`. Keeping the handoff to one seam is what makes
 * the D10 question ("does an `<a download>` click work from an unfocused
 * offscreen document?") answerable by editing ~10 lines instead of the callers.
 *
 * Blob URLs are the one thing here that leaks if we are careless: the worker
 * mints them in another document and cannot enumerate them, so every URL is
 * tracked by download id and revoked exactly once - on `complete`, on
 * `interrupted`, or by a timeout if Chrome never reports either.
 */

export const DOWNLOAD_REVOKE_TIMEOUT_MS = 60_000;
export const EXPORT_DOWNLOAD_CONFLICT_ACTION = 'uniquify' as const;

export interface DownloadOptions {
  url: string;
  filename: string;
  saveAs: boolean;
  conflictAction: typeof EXPORT_DOWNLOAD_CONFLICT_ACTION;
}

export interface DownloadApiLike {
  download?: (options: DownloadOptions) => Promise<number>;
}

export interface DownloadDelta {
  id?: number;
  state?: { current?: string };
}

export type ExportServiceErrorCode = CollectionExportErrorCode | 'EXPORT_FAILED';

export type ExportRequestResult =
  | {
      ok: true;
      downloadId: number;
      filename: string;
      count: number;
      byteLength: number;
    }
  | { ok: false; code: ExportServiceErrorCode; message: string };

export interface ExportServiceDeps {
  build?: (input: {
    sessionKey: string;
    format: CollectionExportFormat;
    label?: string | null;
  }) => Promise<BuildCollectionExportResult>;
  createBlobUrl?: (
    mimeType: string,
    base64: string,
  ) => Promise<OffscreenBlobResponse>;
  revokeBlobUrl?: (url: string) => Promise<OffscreenRevokeResponse>;
  /** The seam. Defaults to `browser.downloads.download`. */
  download?: (options: DownloadOptions) => Promise<number>;
  readSettings?: () => Promise<AmazonSettings>;
  resolveCollectionKey?: (input: {
    jobId?: string;
    collectionKey?: string;
  }) => Promise<string | null>;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  revokeTimeoutMs?: number;
  now?: () => number;
}

interface PendingDownload {
  url: string;
  timer: unknown;
  startedAt: number;
}

const pending = new Map<number, PendingDownload>();

export function pendingDownloadCount(): number {
  return pending.size;
}

export function resetExportServiceForTests(): void {
  for (const entry of pending.values()) {
    if (entry.timer !== null && entry.timer !== undefined) {
      clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
    }
  }
  pending.clear();
}

/** `csv`/`excel`/`clipboard` (settings) -> the two formats a file can be. */
export function toFileFormat(format: ExportFormat): CollectionExportFormat | null {
  if (format === 'csv') return 'csv';
  if (format === 'excel') return 'xlsx';
  // Clipboard export cannot be produced by an unfocused worker (plan 11.2).
  return null;
}

function readDownloadApi(): DownloadApiLike | null {
  try {
    const g = globalThis as unknown as {
      browser?: { downloads?: DownloadApiLike };
      chrome?: { downloads?: DownloadApiLike };
    };
    const api = g.browser?.downloads ?? g.chrome?.downloads;
    if (api && typeof api.download === 'function') return api;
  } catch {
    // No downloads API in this context (tests, Firefox without permission).
  }
  return null;
}

async function defaultDownload(options: DownloadOptions): Promise<number> {
  const api = readDownloadApi();
  if (!api?.download) {
    throw new Error('Downloads are unavailable');
  }
  return api.download(options);
}

/**
 * One download, one tracked blob URL. Any failure after the URL exists revokes it
 * immediately, so a refused download cannot leave a megabyte-sized object alive
 * for the lifetime of the offscreen document.
 */
type DownloadOutcome =
  | { ok: true; downloadId: number; filename: string }
  | { ok: false; code: ExportServiceErrorCode; message: string };

async function downloadBlob(
  built: { base64: string; mimeType: string; filename: string },
  deps: ExportServiceDeps,
): Promise<DownloadOutcome> {
  const createBlobUrl = deps.createBlobUrl ?? createBlobUrlViaOffscreen;
  const blob = await createBlobUrl(built.mimeType, built.base64);
  if (!blob.ok) {
    return {
      ok: false,
      code: 'EXPORT_FAILED',
      message: `Could not prepare the file: ${blob.message}`,
    };
  }

  const revoke = deps.revokeBlobUrl ?? revokeBlobUrlViaOffscreen;
  const download = deps.download ?? defaultDownload;

  let downloadId: number;
  try {
    downloadId = await download({
      url: blob.url,
      filename: built.filename,
      saveAs: false,
      conflictAction: EXPORT_DOWNLOAD_CONFLICT_ACTION,
    });
  } catch (error) {
    await revoke(blob.url);
    return {
      ok: false,
      code: 'EXPORT_FAILED',
      message:
        error instanceof Error
          ? `Could not start the download: ${error.message}`
          : 'Could not start the download',
    };
  }

  const setTimer = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer =
    deps.clearTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const timeoutMs = deps.revokeTimeoutMs ?? DOWNLOAD_REVOKE_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());

  const entry: PendingDownload = {
    url: blob.url,
    startedAt: now(),
    timer: null,
  };
  entry.timer = setTimer(() => {
    // Chrome never told us how the download ended (worker slept, browser
    // closed, event missed). Revoke anyway; the file is already on disk.
    if (pending.delete(downloadId)) {
      void revoke(entry.url);
    }
  }, timeoutMs);
  pending.set(downloadId, entry);

  return { ok: true, downloadId, filename: built.filename };
}

export async function requestCollectionExport(
  input: { sessionKey: string; label?: string | null; format?: CollectionExportFormat },
  deps: ExportServiceDeps = {},
): Promise<ExportRequestResult> {
  const readSettings = deps.readSettings ?? getSettings;
  const settings = await readSettings();
  const format = input.format ?? toFileFormat(settings.exportFormat) ?? 'csv';

  const build = deps.build ?? buildCollectionExport;
  const built = await build({
    sessionKey: input.sessionKey,
    format,
    label: input.label,
  });

  if (!built.ok) {
    return { ok: false, code: built.code, message: built.message };
  }

  const result = await downloadBlob(built, deps);
  if (!result.ok) return result;

  return {
    ok: true,
    downloadId: result.downloadId,
    filename: result.filename,
    count: built.count,
    byteLength: built.byteLength,
  };
}

/**
 * `downloads.onChanged` handler. A finished download frees its blob URL exactly
 * once; a second event for the same id is a no-op.
 */
export function handleDownloadChanged(
  delta: DownloadDelta | undefined,
  deps: Pick<ExportServiceDeps, 'revokeBlobUrl' | 'clearTimeout'> = {},
): boolean {
  const id = delta?.id;
  if (typeof id !== 'number') return false;

  const state = delta?.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return false;

  const entry = pending.get(id);
  if (!entry) return false;

  pending.delete(id);
  const clearTimer =
    deps.clearTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  if (entry.timer !== null && entry.timer !== undefined) {
    clearTimer(entry.timer);
  }

  const revoke = deps.revokeBlobUrl ?? revokeBlobUrlViaOffscreen;
  void revoke(entry.url);
  return true;
}

/**
 * Which collection an `EXPORT_SAVED_PRODUCT` means: the explicit key, else the
 * job the toast belongs to, else whatever the one-click pointer considers
 * current. Never a guess based on recency.
 */
export async function resolveExportCollection(input: {
  jobId?: string;
  collectionKey?: string;
}): Promise<string | null> {
  if (input.collectionKey) return input.collectionKey;

  if (input.jobId) {
    const job = saveJobStore.get(input.jobId);
    if (job?.sessionKey) return job.sessionKey;
  }

  const pointer = await readOneClickCollection();
  return pointer?.sessionKey ?? null;
}

export async function handleExportSavedProduct(
  payload: { jobId?: string; collectionKey?: string },
  deps: ExportServiceDeps = {},
): Promise<ExportRequestResult> {
  const sessionKey = await (deps.resolveCollectionKey ?? resolveExportCollection)(
    payload,
  );
  if (!sessionKey) {
    return {
      ok: false,
      code: 'EXPORT_INVALID',
      message: 'Could not find the collection for this product',
    };
  }

  const settings = await (deps.readSettings ?? getSettings)();
  const format = toFileFormat(settings.exportFormat);
  if (!format) {
    return {
      ok: false,
      code: 'EXPORT_FAILED',
      message: 'Clipboard export is only available in the side panel',
    };
  }

  return requestCollectionExport(
    { sessionKey, format },
    { ...deps, readSettings: deps.readSettings ?? (async () => settings) },
  );
}

/**
 * `quickSaveAutoDownload` (plan 11.3, default off): the same service, triggered
 * by a completed save instead of a click. Kept out of `handleSaveProduct` so the
 * save path stays free of export concerns.
 */
export async function maybeAutoExportOnSave(
  update: { state: string; collectionKey?: string; collectionLabel?: string },
  deps: ExportServiceDeps = {},
): Promise<ExportRequestResult | null> {
  if (update.state !== 'completed' || !update.collectionKey) return null;

  const settings = await (deps.readSettings ?? getSettings)();
  if (!settings.quickSaveAutoDownload) return null;

  const format = toFileFormat(settings.exportFormat);
  if (!format) return null;

  return requestCollectionExport(
    {
      sessionKey: update.collectionKey,
      label: update.collectionLabel,
      format,
    },
    { ...deps, readSettings: async () => settings },
  );
}
