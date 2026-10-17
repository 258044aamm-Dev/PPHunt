import { useCallback, useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/database';
import { useCollectionStore } from '../store/collectionStore';
import { useUIStore } from '../store/uiStore';
import { modalAriaProps } from '@/lib/utils/a11y';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { formatNumber } from '@/lib/utils/formatters';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';
import { ExportModal } from './ExportModal';

/**
 * Post-extraction completion dialog & record-scoped export host (SAD-135 & SAD-136).
 *
 * Automatically displayed when an extraction finishes (status === 'completed').
 * Never displayed when status === 'error'.
 *
 * Provides three distinct actions:
 * 1. Preview Current Extraction — Opens the structured full-width overlay table
 * 2. Export Current Extraction — Opens CSV / XLSX / Clipboard export modal
 * 3. Try Another Extraction — Preserves current extracted data in IndexedDB & History
 *    and resets collection controls to 'idle' ready for the next extraction.
 */
export function ExtractionCompleteModal() {
  const status = useCollectionStore((s) => s.status);
  const errorMessage = useCollectionStore((s) => s.errorMessage);
  const collectedCount = useCollectionStore((s) => s.collectedCount);
  const mode = useCollectionStore((s) => s.mode);
  const targetCount = useCollectionStore((s) => s.targetCount);
  const setStatus = useCollectionStore((s) => s.setStatus);
  const setError = useCollectionStore((s) => s.setError);

  const completionDialogOpen = useUIStore((s) => s.completionDialogOpen);
  const selectedSessionKey = useUIStore((s) => s.selectedSessionKey);
  const closeCompletionDialog = useUIStore((s) => s.closeCompletionDialog);
  const openPreviewOverlay = useUIStore((s) => s.openPreviewOverlay);
  const exportModalOpen = useUIStore((s) => s.exportModalOpen);
  const openExportModal = useUIStore((s) => s.openExportModal);
  const closeExportModal = useUIStore((s) => s.closeExportModal);
  const setActiveTab = useUIStore((s) => s.setActiveTab);

  const storedProducts = useLiveQuery(async () => {
    if (selectedSessionKey) {
      const scoped = await db.products
        .where('sessionKey')
        .equals(selectedSessionKey)
        .toArray();
      return scoped.sort((a, b) =>
        (b.collectedAt ?? '').localeCompare(a.collectedAt ?? '')
      );
    }
    return db.products.orderBy('collectedAt').reverse().toArray();
  }, [selectedSessionKey]);

  const products = useMemo(() => storedProducts ?? [], [storedProducts]);
  const effectiveCount = selectedSessionKey
    ? products.length || collectedCount
    : Math.max(collectedCount, products.length);
  const hasProducts = effectiveCount > 0;

  // Never show completion dialog if extraction failed
  useEffect(() => {
    if (status === 'error' && completionDialogOpen) {
      closeCompletionDialog();
    }
  }, [status, completionDialogOpen, closeCompletionDialog]);

  const handleTryAnotherExtraction = useCallback(() => {
    // Preserve all extracted products in IndexedDB and History;
    // reset only the active collection status so user can configure a new run safely.
    closeCompletionDialog();
    setError(null);
    setStatus('idle');
    setActiveTab('collect');
  }, [closeCompletionDialog, setError, setStatus, setActiveTab]);

  const handleExportCurrentExtraction = useCallback(() => {
    if (!hasProducts) return;
    closeCompletionDialog();
    openExportModal(selectedSessionKey);
  }, [hasProducts, closeCompletionDialog, openExportModal, selectedSessionKey]);

  const handlePreviewCurrentExtraction = useCallback(() => {
    if (!hasProducts) return;
    setOverlayFullWidthMode(true);
    openPreviewOverlay(selectedSessionKey);
  }, [hasProducts, openPreviewOverlay, selectedSessionKey]);

  const showDialog =
    completionDialogOpen && status !== 'error' && !errorMessage;

  // L-6 (SAD-194): focus trap + Escape-to-close + focus restore on close.
  const focusTrapRef = useFocusTrap<HTMLDivElement>(showDialog, closeCompletionDialog);

  return (
    <>
      {showDialog && (
        <div
          ref={focusTrapRef}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 dark:bg-black/60 p-4"
        >
          <div
            className="bg-surface border border-hairline-soft rounded-md p-5 max-w-sm w-full shadow-lg"
            {...modalAriaProps('extraction-complete-title')}
          >
            {/* Status badge & close button */}
            <div className="flex items-center justify-between mb-3">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-sm bg-surface-card border border-hairline-soft">
                <span
                  className={`w-2 h-2 rounded-full ${
                    hasProducts ? 'bg-moss' : 'bg-golden'
                  }`}
                />
                <span className="font-sans text-xs font-medium text-ink">
                  {hasProducts ? 'Extraction Complete' : 'No Products Extracted'}
                </span>
              </div>
              <button
                type="button"
                onClick={closeCompletionDialog}
                className="w-7 h-7 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft transition-colors"
                aria-label="Close dialog"
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

            {/* Heading */}
            <h3
              id="extraction-complete-title"
              className="font-serif text-base font-semibold text-ink mb-1.5"
            >
              {hasProducts
                ? `${formatNumber(effectiveCount)} Product${
                    effectiveCount !== 1 ? 's' : ''
                  } Extracted`
                : '0 Products Found on This Page'}
            </h3>

            {/* Description & preservation note */}
            <p className="font-serif text-xs text-ink-muted mb-4 leading-relaxed">
              {hasProducts ? (
                <>
                  Completed in{' '}
                  <strong className="text-ink font-medium capitalize">
                    {mode}
                  </strong>{' '}
                  mode
                  {mode === 'automatic' ? ` (target: ${targetCount})` : ''}. Your
                  current results are safely preserved until you explicitly reset
                  or clear them.
                </>
              ) : (
                <>
                  No Amazon product listings were detected on the current view.
                  Any previously saved products remain intact.
                </>
              )}
            </p>

            {/* Three Distinct Action Options */}
            <div className="space-y-2.5">
              {/* Option 3: Preview Current Extraction */}
              <button
                type="button"
                onClick={handlePreviewCurrentExtraction}
                disabled={!hasProducts}
                className={`
                  w-full text-left px-3.5 py-2.5 rounded-sm border transition-colors flex items-center justify-between
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                  ${
                    hasProducts
                      ? 'bg-clay text-clay-ink border-transparent hover:bg-clay-active cursor-pointer'
                      : 'bg-surface-soft/50 text-ink-subtle border-hairline-soft opacity-60 cursor-not-allowed'
                  }
                `}
              >
                <div>
                  <span className="font-sans text-xs font-semibold block">
                    Preview Current Extraction
                  </span>
                  <span
                    className={`font-serif text-[11px] block mt-0.5 ${
                      hasProducts ? 'text-clay-ink/90' : 'text-ink-subtle'
                    }`}
                  >
                    Review extracted data in a structured full-width overlay table
                  </span>
                </div>
                <span className="font-sans text-sm ml-2 shrink-0">→</span>
              </button>

              {/* Option 2: Export Current Extraction */}
              <button
                type="button"
                onClick={handleExportCurrentExtraction}
                disabled={!hasProducts}
                className={`
                  w-full text-left px-3.5 py-2.5 rounded-sm border transition-colors flex items-center justify-between
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                  ${
                    hasProducts
                      ? 'bg-surface-card text-ink border-hairline hover:bg-surface-soft cursor-pointer'
                      : 'bg-surface-soft/50 text-ink-subtle border-hairline-soft opacity-60 cursor-not-allowed'
                  }
                `}
              >
                <div>
                  <span className="font-sans text-xs font-semibold block">
                    Export Current Extraction
                  </span>
                  <span className="font-serif text-[11px] text-ink-muted block mt-0.5">
                    Download as CSV, Excel (.xlsx), or copy to clipboard
                  </span>
                </div>
                <span className="font-sans text-xs text-clay font-semibold ml-2 shrink-0">
                  CSV / XLSX
                </span>
              </button>

              {/* Option 1: Try Another Extraction */}
              <button
                type="button"
                onClick={handleTryAnotherExtraction}
                className="w-full text-left px-3.5 py-2.5 rounded-sm border border-hairline bg-surface text-ink hover:bg-surface-soft transition-colors flex items-center justify-between cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay"
              >
                <div>
                  <span className="font-sans text-xs font-semibold block">
                    Try Another Extraction
                  </span>
                  <span className="font-serif text-[11px] text-ink-muted block mt-0.5">
                    Start a new extraction while keeping current results saved
                  </span>
                </div>
                <span className="font-sans text-xs text-ink-muted ml-2 shrink-0">
                  ↺
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Standalone Export Modal triggered from Completion Dialog, Full-Width Preview, or History Tab */}
      <ExportModal
        isOpen={exportModalOpen}
        onClose={closeExportModal}
        allProducts={products}
        selectedProducts={[]}
        filteredProducts={products}
        hasFilter={false}
        hasSelection={false}
      />
    </>
  );
}
