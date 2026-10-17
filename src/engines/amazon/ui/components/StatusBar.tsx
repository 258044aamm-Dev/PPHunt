import {
  useAmazonCollectionStore,
  type CollectionStatus,
} from '../store/collectionStore';

const STATUS_CONFIG: Record<CollectionStatus, { label: string; color: string }> =
  {
    idle: { label: 'Ready', color: 'bg-sage' },
    collecting: { label: 'Collecting', color: 'bg-moss animate-pulse' },
    paused: { label: 'Paused', color: 'bg-golden' },
    completed: { label: 'Complete', color: 'bg-moss' },
    error: { label: 'Error', color: 'bg-crimson' },
    interrupted: { label: 'Interrupted', color: 'bg-golden' },
  };

export function AmazonStatusBar() {
  const status = useAmazonCollectionStore((s) => s.status);
  const { label, color } = STATUS_CONFIG[status];

  return (
    <div
      className="flex items-center gap-2 mb-3"
      role="status"
      aria-label={`Status: ${label}`}
    >
      <span
        className={`w-2.5 h-2.5 rounded-full ${color} shrink-0`}
        aria-hidden="true"
      />
      <span className="font-serif text-sm font-medium text-ink">{label}</span>
    </div>
  );
}

export { AmazonStatusBar as StatusBar };
