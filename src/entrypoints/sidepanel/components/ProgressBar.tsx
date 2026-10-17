import { useCollectionStore } from '../store/collectionStore';

/**
 * Progress bar with flat solid fill per PPHunt design system.
 * - Idle: empty (0%)
 * - Collecting / Complete: solid clay fill with smooth width transition
 * - Error: solid crimson fill
 */
export function ProgressBar() {
  const collected = useCollectionStore((s) => s.collectedCount);
  const target = useCollectionStore((s) => s.targetCount);
  const status = useCollectionStore((s) => s.status);

  const percent = target > 0 ? Math.min(100, (collected / target) * 100) : 0;

  const barColor = status === 'error' ? 'bg-crimson' : 'bg-clay';

  return (
    <div
      className="w-full h-2 bg-surface-soft border border-hairline-soft rounded-full overflow-hidden"
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Collection progress: ${Math.round(percent)}%`}
    >
      <div
        className={`h-full rounded-full transition-all duration-300 ease-out ${barColor}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
