import { CollectionMode } from './CollectionMode';
import { TargetSelector } from './TargetSelector';
import { StatusBar } from './StatusBar';
import { CounterDisplay } from './CounterDisplay';
import { ProgressBar } from './ProgressBar';
import { CollectionControls } from './CollectionControls';
import { useCollectionStore } from '../store/collectionStore';

/**
 * Collect tab — the main collection interface.
 * Shows mode selector, target selector, status bar, counter, progress bar, and controls.
 * When not on an Amazon page, shows a warning banner.
 */
export function CollectTab() {
  const isAmazonPage = useCollectionStore((s) => s.isAmazonPage);

  return (
    <div className="space-y-3">
      {/* Amazon page warning */}
      {!isAmazonPage && (
        <div className="bg-golden/15 border border-golden/40 rounded-md p-3.5">
          <p className="font-sans text-xs font-semibold text-ink">
            ⚠ Not on Amazon
          </p>
          <p className="font-serif text-xs text-ink-muted mt-1 leading-relaxed">
            Navigate to an Amazon search, product, or category page to start collecting.
          </p>
        </div>
      )}

      <CollectionMode />
      <TargetSelector />

      {/* Status section */}
      <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
        <StatusBar />
        <CounterDisplay />
        <ProgressBar />
      </div>

      <CollectionControls />
    </div>
  );
}
