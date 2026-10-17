import { formatNumber } from '../../utils/formatters';
import { useAmazonCollectionStore } from '../store/collectionStore';

export function AmazonCounterDisplay() {
  const collected = useAmazonCollectionStore((s) => s.collectedCount);
  const target = useAmazonCollectionStore((s) => s.targetCount);
  const status = useAmazonCollectionStore((s) => s.status);
  const isActive = status === 'collecting' || status === 'paused';

  const percent =
    target > 0 ? Math.min(100, Math.round((collected / target) * 100)) : 0;

  return (
    <div className="flex items-center justify-between mb-2">
      <p className="font-mono text-xs text-ink tabular-nums">
        <span className="font-semibold">{formatNumber(collected)}</span>
        <span className="text-ink-muted">
          {' / '}
          {formatNumber(target)}
        </span>
      </p>
      {isActive && (
        <p className="font-mono text-xs text-ink-muted tabular-nums">
          {percent}%
        </p>
      )}
    </div>
  );
}

export { AmazonCounterDisplay as CounterDisplay };
