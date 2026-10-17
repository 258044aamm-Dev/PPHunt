import { useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useConfirmDialog } from '@/entrypoints/sidepanel/components/ConfirmDialog';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';
import { db } from '../../db/database';
import { clearAllHistory, deleteHistory } from '../../db/history';
import { pruneOldSessions } from '../../db/sessions';
import { useAmazonUIStore } from '../store/uiStore';
import { AmazonHistoryEntry } from './HistoryEntry';

/**
 * History tab — shows past Amazon extraction sessions in chronological order.
 */
export function AmazonHistoryTab() {
  const openPreviewOverlay = useAmazonUIStore((s) => s.openPreviewOverlay);
  const openExportModal = useAmazonUIStore((s) => s.openExportModal);
  const { askConfirm, confirmDialog } = useConfirmDialog();

  const history = useLiveQuery(
    () => db.history.orderBy('startedAt').reverse().toArray(),
    [],
  );

  const handlePreview = useCallback(
    (sessionKey: string) => {
      setOverlayFullWidthMode(true);
      openPreviewOverlay(sessionKey);
    },
    [openPreviewOverlay],
  );

  const handleExport = useCallback(
    (sessionKey: string) => {
      openExportModal(sessionKey);
    },
    [openExportModal],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      const ok = await askConfirm({
        title: 'Delete history entry?',
        message: 'Delete this history entry?',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!ok) return;
      await deleteHistory(id);
    },
    [askConfirm],
  );

  const handleClearAll = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Clear all history?',
      message:
        'Clear all collection history? The products belonging to those history entries will also be deleted. This cannot be undone.',
      confirmLabel: 'Clear All',
      tone: 'danger',
    });
    if (!ok) return;
    await clearAllHistory();
    void pruneOldSessions(0).catch(() => {});
  }, [askConfirm]);

  if (history === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-hairline-soft border-t-clay rounded-full animate-spin" />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="w-16 h-16 rounded-full bg-surface-card border border-hairline-soft flex items-center justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-ink-muted"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12,6 12,12 16,14" />
          </svg>
        </div>
        <h3 className="font-serif text-base font-semibold text-ink mb-2">
          No history yet
        </h3>
        <p className="font-serif text-xs text-ink-muted leading-relaxed max-w-xs">
          Past collection sessions will appear here once you complete a
          collection. You can preview or export any session from here.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-serif text-sm font-semibold text-ink">
          {history.length} session{history.length !== 1 ? 's' : ''}
        </h3>
        <button
          type="button"
          onClick={handleClearAll}
          className="font-sans text-xs font-medium text-ink-muted hover:text-crimson transition-colors"
        >
          Clear All
        </button>
      </div>

      <div className="space-y-2.5">
        {history.map((entry) => (
          <AmazonHistoryEntry
            key={entry.id ?? entry.sessionKey}
            entry={entry}
            onPreview={handlePreview}
            onExport={handleExport}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {confirmDialog}
    </div>
  );
}

export { AmazonHistoryTab as HistoryTab };
