import {
  DEFAULT_ENRICH_COLLECTED_LIMIT,
  DEFAULT_RATING_BACKFILL,
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
 * a run may pay for that request, and that budget bounds full detail only —
 * SAD-384 fetches a missing brand/Best Sellers Rank independently of it.
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
    description: 'Fetch full details for at most 25 products; missing brand/rank fallback is not capped.',
  },
  {
    value: '50',
    title: '50 products per run',
    description: 'The default: full details for 50 products per run, plus missing brand/rank fallback.',
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
  // SAD-383: separate switch, separate stage, on by default.
  const backfillRatings =
    settings?.backfillCollectedRatings ?? DEFAULT_RATING_BACKFILL;

  const apply = (nextLimit: EnrichCollectedLimit) => {
    void persistSettings({ enrichCollectedLimit: nextLimit });
    // The worker's synchronous cache; same value, written where it can be read.
    void setEnrichCollectedLimit(nextLimit);
  };

  return (
    <div className="space-y-3">
      {/* SAD-383: the rating/review-count backfill. Written immediately for the
          same reason as the radios below — a queued debounce landing after
          "Restore Defaults" would silently re-enable outbound requests. */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={backfillRatings}
          onChange={(e) =>
            void persistSettings({ backfillCollectedRatings: e.target.checked })
          }
          className="w-3.5 h-3.5 accent-clay cursor-pointer mt-0.5 shrink-0"
        />
        <span>
          <span className="font-sans text-xs font-medium text-ink block">
            Fill missing ratings from the product page
          </span>
          <span className="font-serif text-xs text-ink-muted leading-relaxed">
            A listing card does not always print a rating and review count — the
            Deals grid never does. When one is missing, this makes one small
            request per product to fill just those two fields. A rating the card
            printed is never replaced. On by default.
          </span>
        </span>
      </label>

      <p className="font-serif text-xs text-ink-muted leading-relaxed">
        The product page is always fetched after a collection, because that page
        is the only place Amazon prints{' '}
        <span className="font-sans font-medium text-ink">weight</span> and the
        full <span className="font-sans font-medium text-ink">variation</span>{' '}
        list. The same request also fills the detail fields a save already
        collects — rating, features, seller, availability.
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
          The limit bounds full detail only. Products past it still get a missing
          brand or Best Sellers Rank filled in; every other field stays as their
          listing card showed it.
        </p>
      </div>
    </div>
  );
}
