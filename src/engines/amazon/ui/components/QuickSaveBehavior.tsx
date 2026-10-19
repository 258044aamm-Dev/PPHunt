import type { QuickSaveCollectionBehavior } from '../../types';
import { useAmazonSettings } from '../hooks/useAmazonSettings';
import { useCurrentCollection } from '../hooks/useCurrentCollection';

/**
 * SAD-286 (plan Appendix B): the "Right-Click Save Behavior" setting, rendered
 * inside the existing Collect tab. No new tab, panel or modal.
 */

interface BehaviorOption {
  value: QuickSaveCollectionBehavior;
  title: string;
  description: string;
}

const OPTIONS: BehaviorOption[] = [
  {
    value: 'current',
    title: 'Add to Current Collection',
    description: 'Every saved product joins the collection shown below.',
  },
  {
    value: 'new',
    title: 'New Collection per Product',
    description: 'Each saved product starts its own collection.',
  },
  {
    value: 'ask',
    title: 'Ask Every Time',
    description:
      'The product is saved first, then you choose where it belongs. Cancelling keeps it where it landed.',
  },
];

export function AmazonQuickSaveBehavior() {
  const { settings, updateSettings } = useAmazonSettings();
  const { current } = useCurrentCollection();
  const value = settings?.quickSaveCollectionBehavior ?? 'current';

  return (
    <section className="bg-surface-card border border-hairline-soft rounded-md p-4">
      <h2 className="font-sans text-xs font-semibold text-ink">
        Right-Click Save Behavior
      </h2>

      <div
        role="radiogroup"
        aria-label="Right-Click Save Behavior"
        className="mt-2 space-y-2"
      >
        {OPTIONS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="quick-save-behavior"
              value={option.value}
              checked={value === option.value}
              onChange={() =>
                void updateSettings({ quickSaveCollectionBehavior: option.value })
              }
              className="mt-0.5 accent-clay"
            />
            <span>
              <span className="block font-sans text-xs font-semibold text-ink">
                {option.title}
              </span>
              <span className="block font-serif text-xs text-ink-muted leading-relaxed">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>

      <p className="font-serif text-xs text-ink-muted mt-3">
        New saves go to:{' '}
        <span className="font-semibold text-ink">
          {current?.name ?? 'a new collection on the next save'}
        </span>
      </p>
    </section>
  );
}
