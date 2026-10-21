import {
  DEFAULT_ENRICH_COLLECTED_LIMIT,
  DEFAULT_RATING_BACKFILL,
  ENRICH_COLLECTED_LIMIT_OPTIONS,
  type EnrichCollectedLimit,
} from '../../constants/defaults';
import { updateSettings as persistSettings } from '../../db/settings';
import { useAmazonSettings } from '../hooks/useAmazonSettings';
import { setEnrichCollectedSettings } from '../../utils/enrich-collected-flag';

/**
 * SAD-379: the "Collection Enrichment" settings.
 *
 * The switch decides whether a collection run continues into the same
 * product-page fetch a save performs; the radio group caps how many products
 * per run may pay for that request. Off by default, because with it off a
 * collection is exactly what it was before this ticket.
 *
 * Both writes are immediate rather than debounced (the hook's `updateSettings`
 * waits 500 ms). A queued debounce that lands after "Restore Defaults" would
 * silently re-enable a switch the user just reset, and this switch decides
 * whether the extension makes extra outbound requests — so it is written the
 * moment it is flipped.
 *
 * Two writes, on purpose:
 * - the settings row (IndexedDB) so the choice is persisted and schema-validated
 *   like every other setting;
 * - `storage.local` (via `setEnrichCollectedSettings`) because the service
 *   worker answers "is this on?" synchronously on every collection batch and
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
      'The fullest data, paid for with one request per product. Long runs will look slower in the product table.',
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
  const enabled = settings?.enrichCollectedProducts ?? false;
  const limit =
    settings?.enrichCollectedLimit ?? DEFAULT_ENRICH_COLLECTED_LIMIT;
  // SAD-383: separate switch, separate stage, on by default.
  const backfillRatings =
    settings?.backfillCollectedRatings ?? DEFAULT_RATING_BACKFILL;

  const apply = (next: {
    enabled?: boolean;
    limit?: EnrichCollectedLimit;
  }) => {
    const nextEnabled = next.enabled ?? enabled;
    const nextLimit = next.limit ?? limit;
    void persistSettings({
      enrichCollectedProducts: nextEnabled,
      enrichCollectedLimit: nextLimit,
    });
    // The worker's synchronous cache; same value, written where it can be read.
    void setEnrichCollectedSettings({ enabled: nextEnabled, limit: nextLimit });
  };

  return (
    <div className="space-y-3">
      {/* SAD-383: the rating/review-count backfill. Written immediately for the
          same reason as the switch below — a queued debounce landing after
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

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => apply({ enabled: e.target.checked })}
          className="w-3.5 h-3.5 accent-clay cursor-pointer mt-0.5 shrink-0"
        />
        <span>
          <span className="font-sans text-xs font-medium text-ink block">
            Enrich collected products
          </span>
          <span className="font-serif text-xs text-ink-muted leading-relaxed">
            After a collection stores a product, fetch its product page and fill
            in the detail fields a save already collects (rating, features,
            seller, availability and more). Off by default. Each enriched
            product costs one extra request, so a run takes longer.
          </span>
        </span>
      </label>

      <div>
        <span className="font-sans text-xs font-medium text-ink block mb-1.5">
          Per-run limit
        </span>
        <div
          role="radiogroup"
          aria-label="Per-run enrichment limit"
          aria-disabled={!enabled}
          className={`space-y-2 ${enabled ? '' : 'opacity-50'}`}
        >
          {ENRICH_COLLECTED_LIMIT_OPTIONS.map((value) => (
            <label
              key={value}
              className={`flex items-start gap-2 ${
                enabled ? 'cursor-pointer' : 'cursor-not-allowed'
              }`}
            >
              <input
                type="radio"
                name="enrich-collected-limit"
                value={value}
                checked={limit === value}
                disabled={!enabled}
                onChange={() => apply({ limit: value })}
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
        {!enabled && (
          <p className="mt-2 font-serif text-xs text-ink-subtle">
            Turn the switch on to choose a limit.
          </p>
        )}
      </div>
    </div>
  );
}
