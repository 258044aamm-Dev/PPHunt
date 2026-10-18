import { useCallback, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { PreviewModeSwitcher } from '@/entrypoints/sidepanel/components/PreviewModeSwitcher';
import { modalAriaProps } from '@/lib/utils/a11y';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';
import { formatNumber } from '@/lib/utils/formatters';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';
import {
  openDedicatedPreviewTab,
  savePreviewStateSnapshot,
  type PreviewDisplayMode,
} from '@/lib/preview/previewStateSync';
import { temuDb } from '../../db/database';
import { refreshTemuActiveTab } from '../hooks/useTemuActiveTab';
import { useTemuCollectionStore } from '../store/collectionStore';
import { useTemuUIStore } from '../store/uiStore';
import { TemuProductTable } from '../table/TemuProductTable';

export function TemuFullWidthPreviewModal() {
  const previewOverlayOpen = useTemuUIStore((s) => s.previewOverlayOpen);
  const previewMode = useTemuUIStore((s) => s.previewMode);
  const setPreviewMode = useTemuUIStore((s) => s.setPreviewMode);
  const previewSorting = useTemuUIStore((s) => s.previewSorting);
  const previewGlobalFilter = useTemuUIStore((s) => s.previewGlobalFilter);
  const selectedSessionId = useTemuUIStore((s) => s.selectedSessionId);
  const closePreviewOverlay = useTemuUIStore((s) => s.closePreviewOverlay);
  const openExportModal = useTemuUIStore((s) => s.openExportModal);
  const setActiveTab = useTemuUIStore((s) => s.setActiveTab);

  const prepareForNewExtraction = useTemuCollectionStore(
    (s) => s.prepareForNewExtraction
  );
  const collectedCount = useTemuCollectionStore((s) => s.collectedCount);

  const storedCount = useLiveQuery(async () => {
    if (selectedSessionId) {
      return temuDb.products.where('sessionId').equals(selectedSessionId).count();
    }
    return temuDb.products.count();
  }, [selectedSessionId]);

  const totalCount = selectedSessionId
    ? storedCount ?? 0
    : Math.max(collectedCount, storedCount ?? 0);

  useEffect(() => {
    if (previewOverlayOpen) {
      setOverlayFullWidthMode(previewMode === 'overview');
    }
    return () => {
      if (previewOverlayOpen) {
        setOverlayFullWidthMode(false);
      }
    };
  }, [previewOverlayOpen, previewMode]);

  const handleClose = useCallback(() => {
    setOverlayFullWidthMode(false);
    closePreviewOverlay();
    void refreshTemuActiveTab();
  }, [closePreviewOverlay]);

  const handleSelectPreviewMode = useCallback(
    (mode: PreviewDisplayMode) => {
      if (mode === 'tab') {
        void openDedicatedPreviewTab({
          engine: 'temu',
          sessionKey: selectedSessionId,
          sorting: previewSorting,
          globalFilter: previewGlobalFilter,
        });
        return;
      }
      setPreviewMode(mode);
      setOverlayFullWidthMode(mode === 'overview');
      void savePreviewStateSnapshot({
        engine: 'temu',
        sessionKey: selectedSessionId,
        sorting: previewSorting,
        globalFilter: previewGlobalFilter,
        mode,
      });
    },
    [selectedSessionId, previewSorting, previewGlobalFilter, setPreviewMode],
  );

  const handleTryAnotherExtraction = useCallback(() => {
    setOverlayFullWidthMode(false);
    closePreviewOverlay();
    prepareForNewExtraction();
    setActiveTab('collect');
    void refreshTemuActiveTab();
  }, [closePreviewOverlay, prepareForNewExtraction, setActiveTab]);

  const handleExportCurrentExtraction = useCallback(() => {
    openExportModal(selectedSessionId);
  }, [openExportModal, selectedSessionId]);

  const focusTrapRef = useFocusTrap<HTMLDivElement>(previewOverlayOpen);

  useEffect(() => {
    if (!previewOverlayOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useTemuUIStore.getState().exportModalOpen) {
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
      data-preview-mode={previewMode}
      className="fixed inset-0 z-40 bg-canvas text-ink flex flex-col p-4 overflow-hidden"
      data-testid="temu-fullwidth-preview-overlay"
      {...modalAriaProps('temu-fullwidth-preview-title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-hairline-soft shrink-0">
        <div className="flex items-center gap-2.5">
          <h2
            id="temu-fullwidth-preview-title"
            className="font-serif text-base font-semibold text-ink"
          >
            Preview Current Extraction
          </h2>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-surface-card border border-hairline-soft font-sans text-xs text-ink-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-moss" />
            {formatNumber(totalCount)} product{totalCount !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PreviewModeSwitcher
            currentMode={previewMode}
            onSelectMode={handleSelectPreviewMode}
          />
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

      <div className="flex-1 min-h-0 min-w-0 w-full flex flex-col">
        <TemuProductTable
          fullHeight
          sessionId={selectedSessionId}
          initialSorting={previewSorting}
          initialGlobalFilter={previewGlobalFilter}
        />
      </div>
    </div>
  );
}
