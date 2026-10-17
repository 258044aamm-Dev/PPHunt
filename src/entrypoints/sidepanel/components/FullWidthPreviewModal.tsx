import { useCallback, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/database';
import { ProductTable } from '../table/ProductTable';
import { useUIStore } from '../store/uiStore';
import { useCollectionStore } from '../store/collectionStore';
import { modalAriaProps } from '@/lib/utils/a11y';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { formatNumber } from '@/lib/utils/formatters';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';

/**
 * Structured full-width overlay table modal (SAD-135, SAD-136 & SAD-138).
 *
 * Opens when the user selects "Preview Current Extraction" from the completion
 * dialog OR clicks "Preview" on an extraction record in the History tab.
 * Scopes the table and export actions to `selectedSessionKey` when viewing a
 * specific extraction record.
 */
export function FullWidthPreviewModal() {
  const previewOverlayOpen = useUIStore((s) => s.previewOverlayOpen);
  const selectedSessionKey = useUIStore((s) => s.selectedSessionKey);
  const closePreviewOverlay = useUIStore((s) => s.closePreviewOverlay);
  const openExportModal = useUIStore((s) => s.openExportModal);
  const setActiveTab = useUIStore((s) => s.setActiveTab);

  const setStatus = useCollectionStore((s) => s.setStatus);
  const setError = useCollectionStore((s) => s.setError);
  const collectedCount = useCollectionStore((s) => s.collectedCount);

  const storedCount = useLiveQuery(async () => {
    if (selectedSessionKey) {
      return db.products.where('sessionKey').equals(selectedSessionKey).count();
    }
    return db.products.count();
  }, [selectedSessionKey]);

  const totalCount = selectedSessionKey
    ? storedCount ?? 0
    : Math.max(collectedCount, storedCount ?? 0);

  useEffect(() => {
    if (previewOverlayOpen) {
      setOverlayFullWidthMode(true);
    }
    return () => {
      if (previewOverlayOpen) {
        setOverlayFullWidthMode(false);
      }
    };
  }, [previewOverlayOpen]);

  const handleClose = useCallback(() => {
    setOverlayFullWidthMode(false);
    closePreviewOverlay();
  }, [closePreviewOverlay]);

  const handleTryAnotherExtraction = useCallback(() => {
    setOverlayFullWidthMode(false);
    closePreviewOverlay();
    setError(null);
    setStatus('idle');
    setActiveTab('collect');
  }, [closePreviewOverlay, setError, setStatus, setActiveTab]);

  const handleExportCurrentExtraction = useCallback(() => {
    openExportModal(selectedSessionKey);
  }, [openExportModal, selectedSessionKey]);

  // L-6 (SAD-194): trap focus while open and restore it on close. Escape is
  // handled by the window-level listener below (it must stay window-level: the
  // export-modal-on-top guard needs the keystroke even when focus is outside).
  const focusTrapRef = useFocusTrap<HTMLDivElement>(previewOverlayOpen);

  // Escape to close preview overlay (unless export modal is open on top)
  useEffect(() => {
    if (!previewOverlayOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useUIStore.getState().exportModalOpen) {
        handleClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewOverlayOpen, handleClose]);

  if (!previewOverlayOpen) return null;

  return (
    <div
      ref={focusTrapRef}
      tabIndex={-1}
      className="fixed inset-0 z-40 bg-canvas text-ink flex flex-col p-4 overflow-hidden"
      data-testid="fullwidth-preview-overlay"
      {...modalAriaProps('fullwidth-preview-title')}
    >
      {/* Structured Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-hairline-soft shrink-0">
        <div className="flex items-center gap-2.5">
          <h2
            id="fullwidth-preview-title"
            className="font-serif text-base font-semibold text-ink"
          >
            Preview Current Extraction
          </h2>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-surface-card border border-hairline-soft font-sans text-xs text-ink-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-moss" />
            {formatNumber(totalCount)} product{totalCount !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTryAnotherExtraction}
            className="px-3 py-1.5 font-sans text-xs text-ink bg-surface border border-hairline rounded-sm hover:bg-surface-soft transition-colors cursor-pointer"
          >
            Try Another Extraction
          </button>
          <button
            type="button"
            onClick={handleExportCurrentExtraction}
            disabled={totalCount === 0}
            className={`px-3 py-1.5 font-sans text-xs font-medium rounded-sm transition-colors ${
              totalCount > 0
                ? 'bg-clay text-clay-ink hover:bg-clay-active cursor-pointer'
                : 'bg-surface-soft text-ink-subtle opacity-60 cursor-not-allowed'
            }`}
          >
            Export Current Extraction
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft transition-colors"
            aria-label="Close preview overlay"
            title="Close preview"
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
      </div>

      {/* Full-Width Structured Table scoped to selectedSessionKey */}
      <div className="flex-1 min-h-0 min-w-0 w-full flex flex-col">
        <ProductTable fullHeight sessionKey={selectedSessionKey} />
      </div>
    </div>
  );
}
