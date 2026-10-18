import { useCallback, useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';
import { openDedicatedPreviewTab } from '@/lib/preview/previewStateSync';
import { sortProducts } from '@/lib/sorting/product-sorter';
import { modalAriaProps } from '@/lib/utils/a11y';
import { db } from '../../db/database';
import { formatNumber } from '../../utils/formatters';
import { refreshAmazonActiveTab } from '../hooks/useAmazonActiveTab';
import { useAmazonCollectionStore } from '../store/collectionStore';
import { useAmazonUIStore } from '../store/uiStore';
import { AmazonExportModal } from './ExportModal';

export function AmazonExtractionCompleteModal() {
  const status = useAmazonCollectionStore((s) => s.status);
  const errorMessage = useAmazonCollectionStore((s) => s.errorMessage);
  const collectedCount = useAmazonCollectionStore((s) => s.collectedCount);
  const mode = useAmazonCollectionStore((s) => s.mode);
  const targetCount = useAmazonCollectionStore((s) => s.targetCount);
  const prepareForNewExtraction = useAmazonCollectionStore(
    (s) => s.prepareForNewExtraction,
  );

  const completionDialogOpen = useAmazonUIStore((s) => s.completionDialogOpen);
  const selectedSessionKey = useAmazonUIStore((s) => s.selectedSessionKey);
  const closeCompletionDialog = useAmazonUIStore(
    (s) => s.closeCompletionDialog,
  );
  const openPreviewOverlay = useAmazonUIStore((s) => s.openPreviewOverlay);
  const exportModalOpen = useAmazonUIStore((s) => s.exportModalOpen);
  const openExportModal = useAmazonUIStore((s) => s.openExportModal);
  const closeExportModal = useAmazonUIStore((s) => s.closeExportModal);
  const setActiveTab = useAmazonUIStore((s) => s.setActiveTab);
  const previewSorting = useAmazonUIStore((s) => s.previewSorting);
  const previewGlobalFilter = useAmazonUIStore((s) => s.previewGlobalFilter);

  const storedProducts = useLiveQuery(async () => {
    if (selectedSessionKey) {
      const scoped = await db.products
        .where('sessionKey')
        .equals(selectedSessionKey)
        .toArray();
      return scoped.sort((a, b) =>
        (b.collectedAt ?? '').localeCompare(a.collectedAt ?? ''),
      );
    }
    return db.products.orderBy('collectedAt').reverse().toArray();
  }, [selectedSessionKey]);

  const products = useMemo(() => storedProducts ?? [], [storedProducts]);
  const sortedProducts = useMemo(
    () => sortProducts(products, previewSorting),
    [products, previewSorting],
  );
  const filteredSortedProducts = useMemo(() => {
    if (!previewGlobalFilter) return sortedProducts;
    const lower = previewGlobalFilter.toLowerCase();
    return sortedProducts.filter(
      (p) =>
        (p.title ?? '').toLowerCase().includes(lower) ||
        p.asin.toLowerCase().includes(lower) ||
        (p.brand ?? '').toLowerCase().includes(lower) ||
        (p.seller ?? '').toLowerCase().includes(lower),
    );
  }, [sortedProducts, previewGlobalFilter]);
  const effectiveCount = selectedSessionKey
    ? products.length || collectedCount
    : Math.max(collectedCount, products.length);
  const hasProducts = effectiveCount > 0;

  useEffect(() => {
    if (status === 'error' && completionDialogOpen) {
      closeCompletionDialog();
    }
  }, [status, completionDialogOpen, closeCompletionDialog]);

  const handleTryAnotherExtraction = useCallback(() => {
    closeCompletionDialog();
    prepareForNewExtraction();
    setActiveTab('collect');
    void refreshAmazonActiveTab();
  }, [closeCompletionDialog, prepareForNewExtraction, setActiveTab]);

  const handleExportCurrentExtraction = useCallback(() => {
    if (!hasProducts) return;
    closeCompletionDialog();
    openExportModal(selectedSessionKey);
  }, [hasProducts, closeCompletionDialog, openExportModal, selectedSessionKey]);

  const handlePreviewCurrentExtraction = useCallback(() => {
    if (!hasProducts) return;
    setOverlayFullWidthMode(true);
    openPreviewOverlay(selectedSessionKey, 'overview');
  }, [hasProducts, openPreviewOverlay, selectedSessionKey]);

  const handlePreviewInSidebar = useCallback(() => {
    if (!hasProducts) return;
    setOverlayFullWidthMode(false);
    openPreviewOverlay(selectedSessionKey, 'sidebar');
  }, [hasProducts, openPreviewOverlay, selectedSessionKey]);

  const handlePreviewInDedicatedTab = useCallback(() => {
    if (!hasProducts) return;
    closeCompletionDialog();
    void openDedicatedPreviewTab({
      engine: 'amazon',
      sessionKey: selectedSessionKey,
      sorting: previewSorting,
      globalFilter: previewGlobalFilter,
    });
  }, [
    hasProducts,
    closeCompletionDialog,
    selectedSessionKey,
    previewSorting,
    previewGlobalFilter,
  ]);

  const showDialog =
    completionDialogOpen && status !== 'error' && !errorMessage;

  const focusTrapRef = useFocusTrap<HTMLDivElement>(
    showDialog,
    closeCompletionDialog,
  );

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
            <div className="flex items-center justify-between mb-3">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-sm bg-surface-card border border-hairline-soft">
                <span
                  className={`w-2 h-2 rounded-full ${
                    hasProducts ? 'bg-moss' : 'bg-golden'
                  }`}
                />
                <span className="font-sans text-xs font-medium text-ink">
                  {hasProducts
                    ? 'Extraction Complete'
                    : 'No Products Extracted'}
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

            <p className="font-serif text-xs text-ink-muted mb-4 leading-relaxed">
              {hasProducts ? (
                <>
                  Completed in{' '}
                  <strong className="text-ink font-medium capitalize">
                    {mode}
                  </strong>{' '}
                  mode
                  {mode === 'automatic' ? ` (target: ${targetCount})` : ''}.
                  Your current results are safely preserved until you explicitly
                  reset or clear them.
                </>
              ) : (
                <>
                  No Amazon product listings were detected on the current view.
                  Any previously saved products remain intact.
                </>
              )}
            </p>

            <div className="space-y-2.5">
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
                    Review extracted data in a structured full-width overlay
                    table
                  </span>
                </div>
                <span className="font-sans text-sm ml-2 shrink-0">→</span>
              </button>

              {hasProducts && (
                <div
                  className="grid grid-cols-3 gap-1.5"
                  role="group"
                  aria-label="Open preview in mode"
                >
                  <button
                    type="button"
                    data-testid="completion-preview-sidebar"
                    onClick={handlePreviewInSidebar}
                    className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-ink-muted hover:text-ink hover:bg-surface-soft font-sans text-[11px] font-medium transition-colors cursor-pointer"
                  >
                    Sidebar View
                  </button>
                  <button
                    type="button"
                    data-testid="completion-preview-overview"
                    onClick={handlePreviewCurrentExtraction}
                    className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-ink-muted hover:text-ink hover:bg-surface-soft font-sans text-[11px] font-medium transition-colors cursor-pointer"
                  >
                    Overview 95vw
                  </button>
                  <button
                    type="button"
                    data-testid="completion-preview-tab"
                    onClick={handlePreviewInDedicatedTab}
                    className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-clay hover:bg-surface-soft font-sans text-[11px] font-semibold transition-colors cursor-pointer"
                  >
                    Open in Tab ↗
                  </button>
                </div>
              )}

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

      <AmazonExportModal
        isOpen={exportModalOpen}
        onClose={closeExportModal}
        allProducts={sortedProducts}
        selectedProducts={[]}
        filteredProducts={filteredSortedProducts}
        hasFilter={!!previewGlobalFilter}
        hasSelection={false}
      />
    </>
  );
}

export { AmazonExtractionCompleteModal as ExtractionCompleteModal };
