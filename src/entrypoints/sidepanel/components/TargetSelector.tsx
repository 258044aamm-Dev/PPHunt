import { useState, useCallback } from 'react';
import { useCollectionStore } from '../store/collectionStore';
import { TARGET_QUICK_SELECT, TARGET_MIN, TARGET_MAX } from '@/constants/defaults';

/**
 * Target product count selector.
 * - Quick-select chips: 50, 100, 200, 300
 * - Custom input field with min/max validation
 * - Keyboard shortcuts: Enter to confirm, Escape to blur
 * Disabled while collecting.
 */
export function TargetSelector() {
  const targetCount = useCollectionStore((s) => s.targetCount);
  const setTarget = useCollectionStore((s) => s.setTarget);
  const status = useCollectionStore((s) => s.status);
  const isDisabled = status === 'collecting' || status === 'paused';

  const [customValue, setCustomValue] = useState('');

  const handleChipClick = useCallback(
    (count: number) => {
      setTarget(count);
      setCustomValue('');
    },
    [setTarget]
  );

  const handleCustomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setCustomValue(e.target.value);
    },
    []
  );

  const handleCustomApply = useCallback(() => {
    const parsed = parseInt(customValue, 10);
    if (!isNaN(parsed) && parsed >= TARGET_MIN && parsed <= TARGET_MAX) {
      setTarget(parsed);
    }
  }, [customValue, setTarget]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleCustomApply();
      if (e.key === 'Escape') {
        setCustomValue('');
        (e.target as HTMLInputElement).blur();
      }
    },
    [handleCustomApply]
  );

  return (
    <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
      <h2 className="font-serif text-sm font-semibold text-ink mb-3">Target Products</h2>

      {/* Quick-select chips */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {Array.from(TARGET_QUICK_SELECT).map((count) => {
          const isActive = targetCount === count && customValue === '';
          return (
            <button
              key={count}
              type="button"
              onClick={() => handleChipClick(count)}
              disabled={isDisabled}
              className={`
                px-3 py-1.5 font-mono text-xs rounded-sm border transition-colors
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                ${
                  isActive
                    ? 'bg-surface text-ink border-ink font-semibold'
                    : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                }
                ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {count}
            </button>
          );
        })}
      </div>

      {/* Custom input */}
      <div className="flex items-center gap-2.5">
        <label htmlFor="custom-target-input" className="font-sans text-xs font-medium text-ink-muted shrink-0">
          Custom:
        </label>
        <input
          id="custom-target-input"
          type="number"
          min={TARGET_MIN}
          max={TARGET_MAX}
          value={customValue}
          onChange={handleCustomChange}
          onBlur={handleCustomApply}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={`${targetCount}`}
          className={`
            bg-surface border border-hairline rounded-sm text-ink placeholder:text-ink-subtle font-mono text-xs
            px-3 py-1.5 w-24 focus:border-ink focus:outline-none transition-colors
            ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        />
      </div>
    </div>
  );
}
