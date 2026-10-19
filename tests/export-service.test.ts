/**
 * SAD-291 (P5.2) - the download seam.
 *
 * Everything here is about exactly-once: one file per request, one revoke per
 * blob URL, and an error that never leaves a half-finished download behind.
 * The `download` function is injected everywhere, which is the point of the
 * seam - swapping `chrome.downloads` for an anchor click later touches nothing
 * in these tests except the default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AMAZON_SETTINGS } from '@/engines/amazon/constants/defaults';
import {
  DOWNLOAD_REVOKE_TIMEOUT_MS,
  EXPORT_DOWNLOAD_CONFLICT_ACTION,
  handleDownloadChanged,
  handleExportSavedProduct,
  maybeAutoExportOnSave,
  pendingDownloadCount,
  requestCollectionExport,
  resetExportServiceForTests,
  toFileFormat,
} from '@/engines/amazon/background/export-service';
import type { AmazonSettings } from '@/engines/amazon/types';

const settings = {
  ...DEFAULT_AMAZON_SETTINGS,
  exportFormat: 'csv',
  quickSaveAutoDownload: false,
} as AmazonSettings;

const built = {
  ok: true as const,
  filename: 'pphunt-amazon-2026-10-19-002-writing-tools.csv',
  base64: 'QUJD',
  mimeType: 'text/csv;charset=utf-8',
  byteLength: 3,
  count: 2,
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    build: vi.fn(
      async (_input: { sessionKey: string; format: string; label?: string | null }) =>
        built,
    ),
    createBlobUrl: vi.fn(async () => ({ ok: true as const, url: 'blob:1', size: 3 })),
    revokeBlobUrl: vi.fn(async () => ({ ok: true as const })),
    download: vi.fn(async () => 7),
    readSettings: vi.fn(async () => settings),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  resetExportServiceForTests();
});

describe('requestCollectionExport', () => {
  it('builds, mints a URL and downloads once with uniquify', async () => {
    const deps = makeDeps();

    const result = await requestCollectionExport(
      { sessionKey: 'oc_1', label: 'Writing Tools' },
      deps,
    );

    expect(result).toEqual({
      ok: true,
      downloadId: 7,
      filename: built.filename,
      count: 2,
      byteLength: 3,
    });
    expect(deps.build).toHaveBeenCalledWith({
      sessionKey: 'oc_1',
      format: 'csv',
      label: 'Writing Tools',
    });
    expect(deps.createBlobUrl).toHaveBeenCalledWith(built.mimeType, built.base64);
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.download).toHaveBeenCalledWith({
      url: 'blob:1',
      filename: built.filename,
      saveAs: false,
      conflictAction: EXPORT_DOWNLOAD_CONFLICT_ACTION,
    });
    expect(pendingDownloadCount()).toBe(1);
  });

  it('maps the settings format, defaulting to csv', async () => {
    const deps = makeDeps();
    await requestCollectionExport({ sessionKey: 'oc_1' }, deps);
    expect(deps.build.mock.calls[0]![0].format).toBe('csv');

    resetExportServiceForTests();
    const excelDeps = makeDeps({
      readSettings: vi.fn(async () => ({ ...settings, exportFormat: 'excel' })),
    });
    await requestCollectionExport({ sessionKey: 'oc_1' }, excelDeps);
    expect(excelDeps.build.mock.calls[0]![0].format).toBe('xlsx');
  });

  it('does not download when the build fails', async () => {
    const deps = makeDeps({
      build: vi.fn(async () => ({
        ok: false as const,
        code: 'EXPORT_INVALID' as const,
        message: 'This collection has no products to export',
      })),
    });

    const result = await requestCollectionExport({ sessionKey: 'oc_1' }, deps);

    expect(result).toMatchObject({ ok: false, code: 'EXPORT_INVALID' });
    expect(deps.createBlobUrl).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('does not download when the blob URL cannot be minted', async () => {
    const deps = makeDeps({
      createBlobUrl: vi.fn(async () => ({
        ok: false as const,
        code: 'BLOB_FAILED' as const,
        message: 'URL.createObjectURL is unavailable',
      })),
    });

    const result = await requestCollectionExport({ sessionKey: 'oc_1' }, deps);

    expect(result).toMatchObject({ ok: false, code: 'EXPORT_FAILED' });
    expect(deps.download).not.toHaveBeenCalled();
    expect(pendingDownloadCount()).toBe(0);
  });

  it('revokes immediately when the download cannot start', async () => {
    const deps = makeDeps({
      download: vi.fn(async () => {
        throw new Error('downloads permission is missing');
      }),
    });

    const result = await requestCollectionExport({ sessionKey: 'oc_1' }, deps);

    expect(result).toMatchObject({ ok: false, code: 'EXPORT_FAILED' });
    expect(result.ok === false && result.message).toMatch(/permission/);
    expect(deps.revokeBlobUrl).toHaveBeenCalledWith('blob:1');
    expect(pendingDownloadCount()).toBe(0);
  });

  it('runs two collections concurrently without mixing their URLs', async () => {
    const urls = ['blob:1', 'blob:2'];
    const deps = makeDeps({
      createBlobUrl: vi.fn(async () => ({
        ok: true as const,
        url: urls.shift()!,
        size: 3,
      })),
      download: vi.fn(async ({ url }: { url: string }) =>
        url === 'blob:1' ? 11 : 22,
      ),
    });

    const [a, b] = await Promise.all([
      requestCollectionExport({ sessionKey: 'oc_1' }, deps),
      requestCollectionExport({ sessionKey: 'oc_2' }, deps),
    ]);

    expect(a).toMatchObject({ ok: true, downloadId: 11 });
    expect(b).toMatchObject({ ok: true, downloadId: 22 });
    expect(pendingDownloadCount()).toBe(2);
  });
});

describe('handleDownloadChanged', () => {
  async function start() {
    const deps = makeDeps();
    const result = await requestCollectionExport({ sessionKey: 'oc_1' }, deps);
    expect(result.ok).toBe(true);
    return deps;
  }

  it('revokes once on complete and ignores the repeat event', async () => {
    const deps = await start();

    expect(
      handleDownloadChanged({ id: 7, state: { current: 'complete' } }, deps),
    ).toBe(true);
    expect(deps.revokeBlobUrl).toHaveBeenCalledTimes(1);
    expect(deps.revokeBlobUrl).toHaveBeenCalledWith('blob:1');
    expect(deps.clearTimeout).toHaveBeenCalledTimes(1);
    expect(pendingDownloadCount()).toBe(0);

    expect(
      handleDownloadChanged({ id: 7, state: { current: 'complete' } }, deps),
    ).toBe(false);
    expect(deps.revokeBlobUrl).toHaveBeenCalledTimes(1);
  });

  it('revokes on an interrupted download too', async () => {
    const deps = await start();

    expect(
      handleDownloadChanged({ id: 7, state: { current: 'interrupted' } }, deps),
    ).toBe(true);
    expect(deps.revokeBlobUrl).toHaveBeenCalledWith('blob:1');
  });

  it('ignores in-progress and foreign download ids', async () => {
    const deps = await start();

    expect(
      handleDownloadChanged({ id: 7, state: { current: 'in_progress' } }, deps),
    ).toBe(false);
    expect(
      handleDownloadChanged({ id: 999, state: { current: 'complete' } }, deps),
    ).toBe(false);
    expect(handleDownloadChanged(undefined, deps)).toBe(false);
    expect(deps.revokeBlobUrl).not.toHaveBeenCalled();
  });

  it('revokes through the timeout backstop when no event arrives', async () => {
    const timers: Array<() => void> = [];
    const deps = makeDeps({
      setTimeout: vi.fn((handler: () => void) => {
        timers.push(handler);
        return timers.length;
      }),
    });

    await requestCollectionExport({ sessionKey: 'oc_1' }, deps);
    expect(deps.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      DOWNLOAD_REVOKE_TIMEOUT_MS,
    );

    timers[0]!();

    expect(deps.revokeBlobUrl).toHaveBeenCalledTimes(1);
    expect(pendingDownloadCount()).toBe(0);

    // A late real event must not revoke a second time.
    handleDownloadChanged({ id: 7, state: { current: 'complete' } }, deps);
    expect(deps.revokeBlobUrl).toHaveBeenCalledTimes(1);
  });
});

describe('handleExportSavedProduct', () => {
  it('uses the resolved collection and the settings format', async () => {
    const deps = makeDeps({
      resolveCollectionKey: vi.fn(async () => 'oc_9'),
    });

    const result = await handleExportSavedProduct({ jobId: 'job-1' }, deps);

    expect(result.ok).toBe(true);
    expect(deps.build).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'oc_9', format: 'csv' }),
    );
  });

  it('refuses clipboard export outside the panel', async () => {
    const deps = makeDeps({
      resolveCollectionKey: vi.fn(async () => 'oc_9'),
      readSettings: vi.fn(async () => ({ ...settings, exportFormat: 'clipboard' })),
    });

    const result = await handleExportSavedProduct({}, deps);

    expect(result).toMatchObject({ ok: false, code: 'EXPORT_FAILED' });
    expect(result.ok === false && result.message).toMatch(/side panel/i);
    expect(deps.build).not.toHaveBeenCalled();
  });

  it('explains a missing collection instead of exporting the wrong one', async () => {
    const deps = makeDeps({ resolveCollectionKey: vi.fn(async () => null) });

    const result = await handleExportSavedProduct({}, deps);

    expect(result).toMatchObject({ ok: false, code: 'EXPORT_INVALID' });
    expect(deps.build).not.toHaveBeenCalled();
  });
});

describe('maybeAutoExportOnSave', () => {
  it('does nothing while the setting is off', async () => {
    const deps = makeDeps();

    const result = await maybeAutoExportOnSave(
      { state: 'completed', collectionKey: 'oc_1' },
      deps,
    );

    expect(result).toBeNull();
    expect(deps.build).not.toHaveBeenCalled();
  });

  it('exports the saved collection when the setting is on', async () => {
    const deps = makeDeps({
      readSettings: vi.fn(async () => ({ ...settings, quickSaveAutoDownload: true })),
    });

    const result = await maybeAutoExportOnSave(
      { state: 'completed', collectionKey: 'oc_1', collectionLabel: 'Office' },
      deps,
    );

    expect(result).toMatchObject({ ok: true });
    expect(deps.download).toHaveBeenCalledTimes(1);
  });

  it('ignores a save that did not complete', async () => {
    const deps = makeDeps({
      readSettings: vi.fn(async () => ({ ...settings, quickSaveAutoDownload: true })),
    });

    expect(
      await maybeAutoExportOnSave({ state: 'enriching', collectionKey: 'oc_1' }, deps),
    ).toBeNull();
    expect(deps.build).not.toHaveBeenCalled();
  });
});

describe('toFileFormat', () => {
  it('maps settings formats to file formats', () => {
    expect(toFileFormat('csv')).toBe('csv');
    expect(toFileFormat('excel')).toBe('xlsx');
    expect(toFileFormat('clipboard')).toBeNull();
  });
});
