import type { QuickSaveCollectionBehavior } from '../../types';
import { useAmazonSettings } from '../hooks/useAmazonSettings';
import { useCurrentCollection } from '../hooks/useCurrentCollection';

/**
 * SAD-286 (plan Appendix B): the "Right-Click Save Behavior" setting.
 *
 * SAD-332 moved it out of the Collect tab into Settings > Right-Click Save, so
 * the component now renders its content only — the wrapping card belongs to
 * whichever surface hosts it. The control itself is unchanged: same radio
 * group, same values, same write through `updateSettings`.
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
    <div>
      <div role="radiogroup" aria-label="Right-Click Save Behavior" className="space-y-2">
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
    </div>
  );
}
