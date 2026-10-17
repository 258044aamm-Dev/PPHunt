import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExportToast } from '@/entrypoints/sidepanel/components/ExportToast';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';
import type { EmbedImagesMode } from '@/lib/export/excel';
import {
  getExportColumnsFromSettings,
  type ExportFormat,
  type ExportScope,
} from '@/lib/export/types';
import { modalAriaProps } from '@/lib/utils/a11y';
import type { AmazonProduct } from '../../types/product';
import { useAmazonExport } from '../hooks/useAmazonExport';
import { useAmazonSettings } from '../hooks/useAmazonSettings';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  allProducts: AmazonProduct[];
  selectedProducts: AmazonProduct[];
  filteredProducts: AmazonProduct[];
  hasFilter: boolean;
  hasSelection: boolean;
}

const EMBED_OPTIONS: { key: EmbedImagesMode; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'always', label: 'Always' },
  { key: 'never', label: 'Never' },
];

const FORMAT_OPTIONS: { key: ExportFormat; label: string; desc: string }[] = [
  { key: 'csv', label: 'CSV', desc: 'Downloads a .csv file' },
  { key: 'excel', label: 'Excel', desc: 'Downloads a .xlsx file' },
  { key: 'clipboard', label: 'Copy', desc: 'Copies TSV to clipboard' },
];

const SCOPE_OPTIONS: {
  key: ExportScope;
  label: string;
  desc: string;
  enabled: (hasSelection: boolean, hasFilter: boolean) => boolean;
}[] = [
  {
    key: 'all',
    label: 'All Products',
    desc: 'Export every product',
    enabled: () => true,
  },
  {
    key: 'selected',
    label: 'Selected Rows',
    desc: 'Only checked rows',
    enabled: (hasSel) => hasSel,
  },
  {
    key: 'filtered',
    label: 'Filtered Results',
    desc: 'Only matching filter',
    enabled: (_, hasFilter) => hasFilter,
  },
];

export function AmazonExportModal({
  isOpen,
  onClose,
  allProducts,
  selectedProducts,
  filteredProducts,
  hasFilter,
  hasSelection,
}: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [scope, setScope] = useState<ExportScope>('all');
  const [filename, setFilename] = useState(() => {
    const date = new Date().toISOString().split('T')[0];
    return `pphunt-export-${date}`;
  });
  const [includeBOM, setIncludeBOM] = useState(true);
  const [embedImages, setEmbedImages] = useState<EmbedImagesMode>('auto');

  const { settings } = useAmazonSettings();
  const { exportData, isExporting, lastResult, imageProgress, clearResult } =
    useAmazonExport();

  useEffect(() => {
    if (!isOpen || !settings) return;
    setFormat(settings.exportFormat);
    setIncludeBOM(settings.includeBOM);
    setEmbedImages(settings.exportImages);
    const custom = settings.exportFilename?.trim();
    const date = new Date().toISOString().split('T')[0];
    setFilename(custom || `pphunt-export-${date}`);
  }, [isOpen, settings]);

  const visibleColumns = useMemo(
    () => getExportColumnsFromSettings(settings?.enabledFields),
    [settings?.enabledFields],
  );

  const resolvedProducts = useMemo(() => {
    switch (scope) {
      case 'selected':
        return selectedProducts;
      case 'filtered':
        return filteredProducts;
      default:
        return allProducts;
    }
  }, [scope, allProducts, selectedProducts, filteredProducts]);

  const handleExport = useCallback(async () => {
    await exportData(
      format,
      resolvedProducts,
      visibleColumns,
      filename,
      includeBOM,
      { embedImages },
    );
  }, [
    format,
    resolvedProducts,
    visibleColumns,
    filename,
    includeBOM,
    embedImages,
    exportData,
  ]);

  const focusTrapRef = useFocusTrap<HTMLDivElement>(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div
      ref={focusTrapRef}
      tabIndex={-1}
      {...modalAriaProps('export-modal-title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 dark:bg-black/60"
    >
      <div className="bg-surface border border-hairline-soft rounded-md p-5 mx-4 max-w-sm w-full">
        <div className="flex items-center justify-between mb-4">
          <h3
            id="export-modal-title"
            className="font-serif text-base font-semibold text-ink"
          >
            Export Products
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft transition-colors"
            aria-label="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="1" y1="1" x2="13" y2="13" />
              <line x1="13" y1="1" x2="1" y2="13" />
            </svg>
          </button>
        </div>

        <div className="mb-4">
          <label className="font-sans text-xs font-medium text-ink-muted block mb-2">
            Format
          </label>
          <div className="flex gap-2">
            {FORMAT_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setFormat(key)}
                className={`
                  flex-1 px-3 py-2 font-sans text-xs rounded-sm border transition-colors
                  ${
                    format === key
                      ? 'bg-surface-card text-ink border-ink font-medium'
                      : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                  }
                `}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="font-sans text-xs font-medium text-ink-muted block mb-2">
            Scope
          </label>
          <div className="space-y-2">
            {SCOPE_OPTIONS.map(({ key, label, desc, enabled }) => {
              const isEnabled = enabled(hasSelection, hasFilter);
              const isActive = scope === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => isEnabled && setScope(key)}
                  disabled={!isEnabled}
                  className={`
                    w-full text-left px-3 py-2 rounded-sm border transition-colors
                    ${
                      isActive
                        ? 'bg-surface-card text-ink border-ink'
                        : isEnabled
                          ? 'bg-surface-soft/40 text-ink border-hairline hover:bg-surface-soft'
                          : 'bg-transparent text-ink-subtle border-hairline-soft opacity-60 cursor-not-allowed'
                    }
                  `}
                >
                  <span className="font-sans text-xs font-medium block">
                    {label}
                  </span>
                  <span className="font-serif text-xs text-ink-muted">
                    {desc}
                    {key === 'selected' &&
                      hasSelection &&
                      ` (${selectedProducts.length})`}
                    {key === 'filtered' &&
                      hasFilter &&
                      ` (${filteredProducts.length})`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {format !== 'clipboard' && (
          <div className="mb-4">
            <label className="font-sans text-xs font-medium text-ink-muted block mb-2">
              Filename
            </label>
            <input
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className="w-full bg-canvas border border-hairline rounded-sm text-ink font-sans text-xs px-3 py-2 focus:border-ink focus:outline-none transition-colors"
            />
          </div>
        )}

        {format === 'excel' && (
          <div className="mb-4">
            <label className="font-sans text-xs font-medium text-ink-muted block mb-2">
              Embed product images
            </label>
            <div className="flex gap-2">
              {EMBED_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setEmbedImages(key)}
                  aria-pressed={embedImages === key}
                  className={`
                    flex-1 px-3 py-2 font-sans text-xs rounded-sm border transition-colors
                    ${
                      embedImages === key
                        ? 'bg-surface-card text-ink border-ink font-medium'
                        : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                    }
                  `}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] font-sans text-ink-subtle">
              Auto embeds up to 200 images within a 25 MB / 20 s budget; the
              rest fall back to image URLs. This choice applies to this export
              only.
            </p>
          </div>
        )}

        {format === 'csv' && (
          <label className="mb-4 flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeBOM}
              onChange={(e) => setIncludeBOM(e.target.checked)}
              className="w-3.5 h-3.5 accent-clay cursor-pointer"
            />
            <span className="font-sans text-xs text-ink-muted">
              Include UTF-8 BOM (Excel compat)
            </span>
          </label>
        )}

        <p className="font-serif text-xs text-ink-muted mb-4">
          Columns match your enabled Data Fields in Settings (
          {visibleColumns.length} columns).
        </p>

        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting || resolvedProducts.length === 0}
          className={`
            w-full px-5 py-2.5 bg-clay text-clay-ink font-sans text-sm font-medium rounded-sm
            hover:bg-clay-active transition-colors
            ${isExporting || resolvedProducts.length === 0 ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          `}
        >
          {isExporting
            ? imageProgress
              ? `Fetching images… ${imageProgress.fetched}/${imageProgress.total}`
              : 'Exporting…'
            : format === 'clipboard'
              ? `Copy ${resolvedProducts.length} products`
              : `Export ${resolvedProducts.length} products`}
        </button>
      </div>

      <ExportToast result={lastResult} onDismiss={clearResult} />
    </div>
  );
}

export { AmazonExportModal as ExportModal };
