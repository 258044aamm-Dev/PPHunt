import type {
  AmazonSettings,
  EnabledFieldsConfig,
  QuickSaveCollectionBehavior,
} from '../types';

export const TARGET_MIN = 1;
export const TARGET_MAX = 1000;
export const DEFAULT_TARGET_COUNT = 50;
export const TARGET_QUICK_SELECT = [50, 100, 200, 300] as const;
export const MAX_SEEDED_ASINS = 2000;

export const SCROLL_SPEED_MIN = 200;
export const SCROLL_SPEED_MAX = 2000;
export const SCROLL_INTERVAL_MIN = 200;
export const SCROLL_INTERVAL_MAX = 5000;
export const WAIT_AFTER_SCROLL_MIN = 500;
export const WAIT_AFTER_SCROLL_MAX = 5000;

/**
 * SAD-369 (D7): the first 50 products of a collection run each print one
 * diagnostics line; from the 51st onwards that run prints nothing more. The
 * counter counts unique products with a report (re-parses of the same card
 * never burn slots) and resets when a new collection starts. The cap applies
 * to collections only — saving a product always prints (D8).
 */
export const COLLECTION_DIAGNOSTICS_LIMIT = 50;

/**
 * SAD-379: the collection pipeline's enrichment stage.
 *
 * A save continues into the product-page fetch + detail merge; a collection
 * used to stop at the card. These two settings decide whether a collection
 * runs that same stage and how many products per run it may enrich.
 *
 * Default OFF: with the switch off a collection run is byte-identical to
 * before this ticket, which is what keeps every existing feature untouched.
 */
export const DEFAULT_ENRICH_COLLECTED = false;

/**
 * SAD-383: fill `rating`/`reviewCount` from Amazon's review popover when the
 * listing card did not print them.
 *
 * Default ON, and that is a deliberate, documented departure from SAD-379's
 * off-by-default switch. A `/deals` card carries no rating node at all (measured
 * 2026-10-21), so with this off a collection of that grid can never carry the two
 * fields a save of the same card carries — which is the reported bug, not an
 * opt-in improvement. The request is ~3 KB, bounded by the shared enrichment
 * circuit breaker, and made only for products the card could not describe.
 *
 * Setting it to `false` restores the previous behaviour exactly (no request, no
 * queue, no write) and is covered by a test.
 */
export const DEFAULT_RATING_BACKFILL = true;

/**
 * SAD-379: the per-run cap. A string enum rather than a number, matching the
 * house style for a bounded choice (`exportImages`, `quickSaveCollectionBehavior`),
 * so the settings schema stays a plain `z.enum` and the radio values map 1:1.
 * `'all'` resolves to `Number.POSITIVE_INFINITY` in `utils/enrich-collected-flag.ts`.
 */
export const ENRICH_COLLECTED_LIMIT_OPTIONS = ['25', '50', 'all'] as const;
export type EnrichCollectedLimit = (typeof ENRICH_COLLECTED_LIMIT_OPTIONS)[number];
export const DEFAULT_ENRICH_COLLECTED_LIMIT: EnrichCollectedLimit = '50';

export function clampTargetCount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TARGET_COUNT;
  }
  const rounded = Math.round(value);
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, rounded));
}

export const DEFAULT_ENABLED_FIELDS: EnabledFieldsConfig = {
  title: true,
  asin: true,
  url: true,
  price: true,
  listPrice: true,
  discountPercentage: true,
  dealBadge: true,
  currency: true,
  rating: true,
  reviewCount: true,
  bestSellersRank: true,
  pastMonthSales: true,
  coupon: true,
  badge: true,
  delivery: true,
  imageUrl: true,
  isSponsored: true,
  isPrime: true,
  brand: true,
  availability: true,
  seller: true,
  // SAD-333: both fields can only ever come from the product page, so hiding
  // them by default made a right-click save look like data loss. They stay
  // per-field toggles in Settings -> Data Fields.
  description: true,
  features: true,
  // SAD-357: weight is PDP-only and full twister variations come from the PDP
  // (or upgrade search-card swatches on enrichment), so default-on like above.
  variations: true,
  weight: true,
  // SAD-349: PDP-only like the two above, so default-on for the same reason.
  warrantyDescription: true,
};

/**
 * SAD-334: the settings-row schema version. A row written before the field
 * existed has no `settingsVersion` and is treated as version 0; the one-time
 * migration in `db/settings.ts` upgrades it exactly once.
 */
export const CURRENT_SETTINGS_VERSION = 1;

export const DEFAULT_QUICK_SAVE_COLLECTION_BEHAVIOR: QuickSaveCollectionBehavior =
  'current';
export const DEFAULT_QUICK_SAVE_AUTO_DOWNLOAD = false;

export const DEFAULT_AMAZON_SETTINGS: AmazonSettings = {
  id: 'default',
  // SAD-334: factory defaults are already current, so a fresh install (or a
  // reset) is never treated as pre-migration and a later deliberate toggle-off
  // can never be flipped back on.
  settingsVersion: CURRENT_SETTINGS_VERSION,
  defaultMode: 'manual',
  defaultTargetCount: DEFAULT_TARGET_COUNT,
  scrollSpeed: 800,
  scrollInterval: 500,
  waitAfterScroll: 1500,
  duplicateDetection: true,
  exportFormat: 'csv',
  exportFilename: '',
  exportImages: 'auto',
  includeBOM: true,
  notifications: true,
  separateCategorySections: false,
  enabledFields: { ...DEFAULT_ENABLED_FIELDS },
  quickSaveCollectionBehavior: DEFAULT_QUICK_SAVE_COLLECTION_BEHAVIOR,
  quickSaveAutoDownload: DEFAULT_QUICK_SAVE_AUTO_DOWNLOAD,
  // SAD-379: off by default — see DEFAULT_ENRICH_COLLECTED.
  enrichCollectedProducts: DEFAULT_ENRICH_COLLECTED,
  enrichCollectedLimit: DEFAULT_ENRICH_COLLECTED_LIMIT,
  // SAD-383: on by default — see DEFAULT_RATING_BACKFILL.
  backfillCollectedRatings: DEFAULT_RATING_BACKFILL,
};

export const DEFAULT_SETTINGS: AmazonSettings = DEFAULT_AMAZON_SETTINGS;

export const AMAZON_LIMITS = {
  MAX_DB_RECORDS: 50_000,
  DB_WARN_THRESHOLD: 25_000,
  BATCH_WRITE_SIZE: 50,
  SCROLL_STUCK_THRESHOLD: 3,
  CAPTCHA_PAUSE_MS: 30_000,
  MUTATION_DEBOUNCE_MS: 300,
} as const;

export const LIMITS = AMAZON_LIMITS;
