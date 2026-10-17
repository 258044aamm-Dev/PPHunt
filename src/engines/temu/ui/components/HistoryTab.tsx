import { useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';
import { openDedicatedPreviewTab } from '@/lib/preview/previewStateSync';
import { useConfirmDialog } from '@/entrypoints/sidepanel/components/ConfirmDialog';
import { temuDb, type TemuCollectionHistory } from '../../db/database';
import { clearAllTemuHistory, deleteTemuHistory } from '../../db/history';
import { pruneOldTemuSessions } from '../../db/sessions';
import type { TemuCollectionStatus } from '../../types';
import { useTemuUIStore } from '../store/uiStore';

const STATUS_COLORS: Record<TemuCollectionStatus, string> = {
  completed: 'bg-moss',
  stopped: 'bg-golden',
  error: 'bg-crimson',
  collecting: 'bg-clay',
  paused: 'bg-golden',
  idle: 'bg-sage',
};

function TemuHistoryEntry({
  entry,
  onPreview,
  onExport,
  onDelete,
}: {
  entry: TemuCollectionHistory;
  onPreview: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
  onDelete: (id: number) => void;
}) {
  const statusColor = STATUS_COLORS[entry.status];

  const liveSessionCount = useLiveQuery(
    () =>
      entry.sessionId
        ? temuDb.products.where('sessionId').equals(entry.sessionId).count()
        : Promise.resolve(0),
    [entry.sessionId]
  );

  const effectiveCount = Math.max(entry.collectedCount, liveSessionCount ?? 0);
  const hasProducts = effectiveCount > 0;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div
      className="bg-surface-card rounded-md p-3.5 border border-hairline-soft"
      data-testid={`temu-history-entry-${entry.sessionId}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${statusColor} shrink-0`} />
          <span className="font-sans text-xs font-semibold text-ink capitalize">
            {entry.status}
          </span>
          <span className="font-mono text-xs text-ink-muted tabular-nums">
            {effectiveCount} / {entry.targetCount}
          </span>
        </div>
        <span className="font-sans text-xs text-ink-muted shrink-0">
          {formatDate(entry.startedAt)}
        </span>
      </div>

      <p
        className="font-mono text-xs text-ink-muted truncate mb-3"
        title={entry.url}
      >
        {entry.url}
      </p>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="inline-block px-2 py-0.5 bg-surface text-xs font-sans text-ink-muted rounded-sm border border-hairline-soft capitalize">
            {entry.mode}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPreview(entry.sessionId)}
            disabled={!hasProducts}
            aria-label={`Preview extraction from ${entry.url}`}
            className={`px-2.5 py-1 font-sans text-xs font-medium rounded-sm border transition-colors ${
              hasProducts
                ? 'bg-clay text-clay-ink border-transparent hover:bg-clay-active cursor-pointer'
                : 'bg-surface-soft/50 text-ink-subtle border-hairline-soft opacity-60 cursor-not-allowed'
            }`}
          >
            Preview
          </button>

          <button
            type="button"
            data-testid={`temu-history-open-tab-${entry.sessionId}`}
            onClick={() =>
              void openDedicatedPreviewTab({
                engine: 'temu',
                sessionKey: entry.sessionId,
              })
            }
            disabled={!hasProducts}
            aria-label={`Open extraction from ${entry.url} in dedicated tab`}
            title="Open in dedicated full-screen browser tab"
            className={`px-2 py-1 font-sans text-xs font-medium rounded-sm border transition-colors ${
              hasProducts
                ? 'bg-surface text-clay border-hairline hover:bg-surface-soft cursor-pointer'
                : 'bg-surface-soft/50 text-ink-subtle border-hairline-soft opacity-60 cursor-not-allowed'
            }`}
          >
            Tab ↗
          </button>

          <button
            type="button"
            onClick={() => onExport(entry.sessionId)}
            disabled={!hasProducts}
            aria-label={`Export extraction from ${entry.url}`}
            className={`px-2.5 py-1 font-sans text-xs font-medium rounded-sm border transition-colors ${
              hasProducts
                ? 'bg-surface text-ink border-hairline hover:bg-surface-soft cursor-pointer'
                : 'bg-surface-soft/50 text-ink-subtle border-hairline-soft opacity-60 cursor-not-allowed'
            }`}
          >
            Export
          </button>

          {entry.id != null && (
            <button
              type="button"
              onClick={() => onDelete(entry.id!)}
              aria-label={`Delete extraction from ${entry.url}`}
              className="px-2 py-1 font-sans text-xs text-ink-muted hover:text-crimson transition-colors cursor-pointer"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TemuHistoryTab() {
  const openPreviewOverlay = useTemuUIStore((s) => s.openPreviewOverlay);
  const openExportModal = useTemuUIStore((s) => s.openExportModal);
  const { askConfirm, confirmDialog } = useConfirmDialog();

  const history = useLiveQuery(
    () => temuDb.history.orderBy('startedAt').reverse().toArray(),
    []
  );

  const handlePreview = useCallback(
    (sessionId: string) => {
      setOverlayFullWidthMode(true);
      openPreviewOverlay(sessionId);
    },
    [openPreviewOverlay]
  );

  const handleExport = useCallback(
    (sessionId: string) => {
      openExportModal(sessionId);
    },
    [openExportModal]
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
      await deleteTemuHistory(id);
    },
    [askConfirm]
  );

  const handleClearAll = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Clear all history?',
      message:
        'Clear all Temu collection history? The products belonging to those history entries will also be deleted. This cannot be undone.',
      confirmLabel: 'Clear All',
      tone: 'danger',
    });
    if (!ok) return;
    await clearAllTemuHistory();
    void pruneOldTemuSessions(0).catch(() => {});
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
          Past Temu collection sessions will appear here once you complete a
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
          <TemuHistoryEntry
            key={entry.id ?? entry.sessionId}
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
