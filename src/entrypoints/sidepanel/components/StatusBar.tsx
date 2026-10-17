import { useCollectionStore, type CollectionStatus } from '../store/collectionStore';

// L-5 (SAD-197): the Record is typed over the full CollectionStatus union, so
// adding a status without a config entry here fails compilation — the map is
// exhaustive by construction (the never-check the plan asks for).
const STATUS_CONFIG: Record<CollectionStatus, { label: string; color: string }> = {
  idle: { label: 'Ready', color: 'bg-sage' },
  collecting: { label: 'Collecting', color: 'bg-moss animate-pulse' },
  paused: { label: 'Paused', color: 'bg-golden' },
  completed: { label: 'Complete', color: 'bg-moss' },
  error: { label: 'Error', color: 'bg-crimson' },
  interrupted: { label: 'Interrupted', color: 'bg-golden' },
};

/**
 * Status indicator with animated color dot.
 * - Idle: sage (gray-green)
 * - Collecting: moss with pulse animation
 * - Paused: golden
 * - Complete: moss
 * - Error: crimson
 */
export function StatusBar() {
  const status = useCollectionStore((s) => s.status);
  const { label, color } = STATUS_CONFIG[status];

  return (
    <div className="flex items-center gap-2 mb-3" role="status" aria-label={`Status: ${label}`}>
      <span className={`w-2.5 h-2.5 rounded-full ${color} shrink-0`} aria-hidden="true" />
      <span className="font-serif text-sm font-medium text-ink">{label}</span>
    </div>
  );
}
