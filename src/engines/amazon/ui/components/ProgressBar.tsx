import { useAmazonCollectionStore } from '../store/collectionStore';

export function AmazonProgressBar() {
  const collected = useAmazonCollectionStore((s) => s.collectedCount);
  const target = useAmazonCollectionStore((s) => s.targetCount);
  const status = useAmazonCollectionStore((s) => s.status);

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

export { AmazonProgressBar as ProgressBar };
