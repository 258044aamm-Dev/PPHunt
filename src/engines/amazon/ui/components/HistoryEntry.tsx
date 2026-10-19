import { useLiveQuery } from 'dexie-react-hooks';
import { openDedicatedPreviewTab } from '@/lib/preview/previewStateSync';
import { db } from '../../db/database';
import type { CollectionHistory, CollectionStatus } from '../../types';

interface HistoryEntryProps {
  entry: CollectionHistory;
  onPreview: (sessionKey: string) => void;
  onExport: (sessionKey: string) => void;
  onDelete: (id: number) => void;
  /** SAD-286: true when new quick saves land in this collection. */
  isCurrent?: boolean;
  onMakeCurrent?: () => void;
}

const STATUS_COLORS: Record<CollectionStatus, string> = {
  completed: 'bg-moss',
  interrupted: 'bg-golden',
  error: 'bg-crimson',
  collecting: 'bg-clay',
  paused: 'bg-golden',
  idle: 'bg-sage',
};

export function AmazonHistoryEntry({
  entry,
  onPreview,
  onExport,
  onDelete,
  isCurrent = false,
  onMakeCurrent,
}: HistoryEntryProps) {
  const statusColor = STATUS_COLORS[entry.status];

  const liveSessionCount = useLiveQuery(
    () =>
      entry.sessionKey
        ? db.products.where('sessionKey').equals(entry.sessionKey).count()
        : Promise.resolve(0),
    [entry.sessionKey],
  );

  const effectiveCount = Math.max(entry.collectedCount, liveSessionCount ?? 0);
  const hasProducts = effectiveCount > 0;
  // Only one-click collections can be made current; a full-page run is never a
  // quick-save target, so its rows are left exactly as they were.
  const isOneClick =
    entry.origin === 'one-click' || entry.sessionKey.startsWith('oc_');

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
      data-testid={`history-entry-${entry.sessionKey}`}
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
          {isCurrent && (
            <span
              data-testid={`history-current-${entry.sessionKey}`}
              className="px-1.5 py-0.5 bg-clay/15 text-clay font-sans text-[10px] font-semibold uppercase tracking-wide rounded-sm"
            >
              Current
            </span>
          )}
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
          {!isCurrent && isOneClick && onMakeCurrent && (
            <button
              type="button"
              data-testid={`history-make-current-${entry.sessionKey}`}
              onClick={onMakeCurrent}
              aria-label={`Make ${entry.name ?? entry.sessionKey} the current collection`}
              className="px-2 py-1 font-sans text-xs font-medium rounded-sm border border-hairline text-ink-muted hover:text-ink hover:bg-surface-soft transition-colors cursor-pointer"
            >
              Make current
            </button>
          )}

          <button
            type="button"
            onClick={() => onPreview(entry.sessionKey)}
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
            data-testid={`history-open-tab-${entry.sessionKey}`}
            onClick={() =>
              void openDedicatedPreviewTab({
                engine: 'amazon',
                sessionKey: entry.sessionKey,
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
            onClick={() => onExport(entry.sessionKey)}
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

export { AmazonHistoryEntry as HistoryEntry };
