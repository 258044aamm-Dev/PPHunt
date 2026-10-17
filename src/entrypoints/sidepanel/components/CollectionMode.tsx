import { useCollectionStore, type CollectionMode as Mode } from '../store/collectionStore';

/**
 * Manual / Automatic toggle.
 * Pill-style segmented control.
 * - Manual: passive DOM monitoring as user scrolls
 * - Automatic: auto-scroll with configurable speed
 * Disabled while collecting (mode cannot be changed mid-session).
 */
export function CollectionMode() {
  const mode = useCollectionStore((s) => s.mode);
  const setMode = useCollectionStore((s) => s.setMode);
  const status = useCollectionStore((s) => s.status);
  const isDisabled = status === 'collecting' || status === 'paused';

  const options: { key: Mode; label: string; desc: string }[] = [
    { key: 'manual', label: 'Manual', desc: 'Passive — collects as you scroll' },
    { key: 'automatic', label: 'Automatic', desc: 'Auto-scrolls the page' },
  ];

  return (
    <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
      <h2 className="font-serif text-sm font-semibold text-ink mb-3">Collection Mode</h2>
      <div className="flex gap-2">
        {options.map(({ key, label, desc }) => {
          const isActive = mode === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              disabled={isDisabled}
              title={desc}
              className={`
                flex-1 px-4 py-2 font-sans text-sm rounded-sm border transition-colors
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                ${
                  isActive
                    ? 'bg-surface text-ink border-ink font-medium'
                    : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                }
                ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
