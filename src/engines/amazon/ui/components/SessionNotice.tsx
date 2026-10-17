import type { RecoveryNotice } from '../hooks/useAmazonSessionRecovery';

interface SessionNoticeProps {
  notice: RecoveryNotice | null;
  onDismiss: () => void;
  onStartFresh?: () => void;
  onKeepProducts?: () => void;
}

export function AmazonSessionNotice({
  notice,
  onDismiss,
  onStartFresh,
  onKeepProducts,
}: SessionNoticeProps) {
  if (!notice) return null;

  return (
    <div className="bg-golden/15 border border-golden/40 rounded-md p-3.5 mb-3 flex items-start gap-2.5">
      <span className="w-2.5 h-2.5 rounded-full bg-golden shrink-0 mt-1" />
      <div className="flex-1 min-w-0">
        <p className="font-serif text-xs text-ink leading-relaxed">
          {notice.message}
        </p>
        {notice.type === 'page-reloaded' && (
          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={onStartFresh ?? onDismiss}
              className="font-sans text-xs text-clay font-medium hover:text-clay-active transition-colors"
            >
              Start Fresh
            </button>
            <button
              type="button"
              onClick={onKeepProducts ?? onDismiss}
              className="font-sans text-xs text-ink-muted hover:text-ink transition-colors"
            >
              Keep Products
            </button>
          </div>
        )}
        {notice.type !== 'page-reloaded' && (
          <button
            type="button"
            onClick={onDismiss}
            className="font-sans text-xs text-ink-muted hover:text-ink transition-colors mt-1.5"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

export { AmazonSessionNotice as SessionNotice };
