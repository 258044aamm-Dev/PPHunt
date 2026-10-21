import {
  DEFAULT_ENRICH_COLLECTED_LIMIT,
  ENRICH_COLLECTED_LIMIT_OPTIONS,
  type EnrichCollectedLimit,
} from '../../constants/defaults';
import { updateSettings as persistSettings } from '../../db/settings';
import { useAmazonSettings } from '../hooks/useAmazonSettings';
import { setEnrichCollectedLimit } from '../../utils/enrich-collected-flag';

/**
 * SAD-379/SAD-385: the "Collection Enrichment" settings.
 *
 * A collection always continues into the same product-page fetch a save
 * performs — that page is the only place Amazon prints `weight` and the full
 * `variations` list, so with the stage skipped those fields can never be
 * collected. What is left to choose is the per-run budget: how many products of
 * a run may pay for that request.
 *
 * The write is immediate rather than debounced (the hook's `updateSettings`
 * waits 500 ms). A queued debounce that lands after "Restore Defaults" would
 * silently restore a budget the user just reset, and this setting decides how
 * many extra outbound requests a run makes — so it is written the moment it
 * changes.
 *
 * Two writes, on purpose:
 * - the settings row (IndexedDB) so the choice is persisted and schema-validated
 *   like every other setting;
 * - `storage.local` (via `setEnrichCollectedLimit`) because the service worker
 *   answers "what is the budget?" synchronously on every collection batch and
 *   cannot await IndexedDB there. This mirrors the SAD-369 diagnostics switch.
 */

interface LimitOption {
  value: EnrichCollectedLimit;
  title: string;
  description: string;
}

export const LIMIT_OPTIONS: LimitOption[] = [
  {
    value: '25',
    title: '25 products per run',
    description: 'The cheapest option: at most 25 extra product-page requests.',
  },
  {
    value: '50',
    title: '50 products per run',
    description: 'The default — matches the per-batch limit the save path uses.',
  },
  {
    value: 'all',
    title: 'Every collected product',
    description:
      'The default: the fullest data, paid for with one request per product. Long runs will look slower in the product table.',
  },
];

const LIMIT_TITLES: Record<EnrichCollectedLimit, string> = {
  '25': '25 products per run',
  '50': '50 products per run',
  all: 'Every collected product',
};

function readableLimit(limit: EnrichCollectedLimit): string {
  return LIMIT_TITLES[limit] ?? LIMIT_TITLES[DEFAULT_ENRICH_COLLECTED_LIMIT];
}

export function AmazonCollectionEnrichment() {
  const { settings } = useAmazonSettings();
  const limit =
    settings?.enrichCollectedLimit ?? DEFAULT_ENRICH_COLLECTED_LIMIT;

  const apply = (nextLimit: EnrichCollectedLimit) => {
    void persistSettings({ enrichCollectedLimit: nextLimit });
    // The worker's synchronous cache; same value, written where it can be read.
    void setEnrichCollectedLimit(nextLimit);
  };

  return (
    <div className="space-y-3">
      <p className="font-serif text-xs text-ink-muted leading-relaxed">
        After a collection stores a product, its product page is fetched and the
        detail fields a save already collects are filled in — rating, features,
        seller, availability, and the two fields a listing card never shows:{' '}
        <span className="font-sans font-medium text-ink">weight</span> and the
        full <span className="font-sans font-medium text-ink">variation</span>{' '}
        list. Each product costs one extra request, so a run takes longer.
      </p>

      <div>
        <span className="font-sans text-xs font-medium text-ink block mb-1.5">
          Per-run limit
        </span>
        <div
          role="radiogroup"
          aria-label="Per-run enrichment limit"
          className="space-y-2"
        >
          {ENRICH_COLLECTED_LIMIT_OPTIONS.map((value) => (
            <label key={value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="enrich-collected-limit"
                value={value}
                checked={limit === value}
                onChange={() => apply(value)}
                className="mt-0.5 accent-clay"
              />
              <span>
                <span className="block font-sans text-xs font-semibold text-ink">
                  {readableLimit(value)}
                </span>
                <span className="block font-serif text-xs text-ink-muted leading-relaxed">
                  {LIMIT_OPTIONS.find((o) => o.value === value)?.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 font-serif text-xs text-ink-subtle">
          Lower the limit on very long runs: products past it keep the data their
          listing card showed.
        </p>
      </div>
    </div>
  );
}
