import { useCollectionStore } from '../store/collectionStore';
import { formatNumber } from '@/lib/utils/formatters';

/**
 * Displays the collection counter: "0 / 50"
 * Uses tabular monospace for numbers and percentage.
 * Shows percentage when collection is active.
 */
export function CounterDisplay() {
  const collected = useCollectionStore((s) => s.collectedCount);
  const target = useCollectionStore((s) => s.targetCount);
  const status = useCollectionStore((s) => s.status);
  const isActive = status === 'collecting' || status === 'paused';

  const percent = target > 0 ? Math.min(100, Math.round((collected / target) * 100)) : 0;

  return (
    <div className="flex items-center justify-between mb-2">
      <p className="font-mono text-xs text-ink tabular-nums">
        <span className="font-semibold">{formatNumber(collected)}</span>
        <span className="text-ink-muted">{' / '}{formatNumber(target)}</span>
      </p>
      {isActive && (
        <p className="font-mono text-xs text-ink-muted tabular-nums">{percent}%</p>
      )}
    </div>
  );
}
