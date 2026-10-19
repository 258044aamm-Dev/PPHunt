import { useAmazonCollectionStore } from '../store/collectionStore';
import { AmazonCollectionControls } from './CollectionControls';
import { AmazonCollectionMode } from './CollectionMode';
import { AmazonCounterDisplay } from './CounterDisplay';
import { AmazonProgressBar } from './ProgressBar';
import { AmazonStatusBar } from './StatusBar';
import { AmazonTargetSelector } from './TargetSelector';

/**
 * Collect tab — the main Amazon collection interface.
 */
export function AmazonCollectTab() {
  const isAmazonPage = useAmazonCollectionStore((s) => s.isAmazonPage);

  return (
    <div className="space-y-3">
      {!isAmazonPage && (
        <div className="bg-golden/15 border border-golden/40 rounded-md p-3.5">
          <p className="font-sans text-xs font-semibold text-ink">
            ⚠ Not on Amazon
          </p>
          <p className="font-serif text-xs text-ink-muted mt-1 leading-relaxed">
            Navigate to an Amazon search, product, or category page to start
            collecting.
          </p>
        </div>
      )}

      <AmazonCollectionMode />
      <AmazonTargetSelector />

      <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
        <AmazonStatusBar />
        <AmazonCounterDisplay />
        <AmazonProgressBar />
      </div>

      <AmazonCollectionControls />
    </div>
  );
}

export { AmazonCollectTab as CollectTab };
