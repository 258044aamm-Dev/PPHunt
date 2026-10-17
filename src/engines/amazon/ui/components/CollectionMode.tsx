import {
  useAmazonCollectionStore,
  type CollectionMode as Mode,
} from '../store/collectionStore';

/**
 * Manual / Automatic toggle for Amazon collection.
 */
export function AmazonCollectionMode() {
  const mode = useAmazonCollectionStore((s) => s.mode);
  const setMode = useAmazonCollectionStore((s) => s.setMode);
  const status = useAmazonCollectionStore((s) => s.status);
  const isDisabled = status === 'collecting' || status === 'paused';

  const options: { key: Mode; label: string; desc: string }[] = [
    { key: 'manual', label: 'Manual', desc: 'Passive — collects as you scroll' },
    { key: 'automatic', label: 'Automatic', desc: 'Auto-scrolls the page' },
  ];

  return (
    <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
      <h2 className="font-serif text-sm font-semibold text-ink mb-3">
        Collection Mode
      </h2>
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

export { AmazonCollectionMode as CollectionMode };
