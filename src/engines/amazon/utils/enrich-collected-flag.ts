/**
 * SAD-379: the cached reader for the collection enrichment budget.
 *
 * Mirrors the `utils/diagnostics-flag.ts` pattern (SAD-369): the value is
 * mirrored into `storage.local` so the service worker gets a *synchronous*
 * answer on the hot path (every `PRODUCTS_COLLECTED` batch), and
 * `storage.onChanged` keeps the cache live so changing it in Settings takes
 * effect without a worker restart.
 *
 * SAD-385 removed the on/off switch this module used to carry: a collection
 * always enriches, because `weight` and the full `variations` only exist on the
 * product page. What remains is the per-run budget.
 *
 * Everything is defensive and injectable: with no extension APIs (tests, a
 * restricted context) the cache keeps its defaults.
 */
import {
  DEFAULT_ENRICH_COLLECTED_LIMIT,
  ENRICH_COLLECTED_LIMIT_OPTIONS,
  type EnrichCollectedLimit,
} from '../constants/defaults';

/** One `storage.local` key holding `{ limit }` (SAD-379 wrote `{ enabled, limit }`). */
export const ENRICH_COLLECTED_KEY = 'pphuntEnrichCollected';

export interface StoredEnrichCollected {
  limit: EnrichCollectedLimit;
}

type StorageListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

interface FlagStorageLike {
  storage?: {
    local?: {
      get?: (keys: string) => Promise<Record<string, unknown>>;
      set?: (items: Record<string, unknown>) => Promise<void>;
    };
    onChanged?: {
      addListener?: (listener: StorageListener) => void;
      removeListener?: (listener: StorageListener) => void;
    };
  };
}

function defaultBrowserLike(): unknown {
  return (
    (globalThis as { browser?: unknown }).browser ??
    (globalThis as { chrome?: unknown }).chrome
  );
}

function storageOf(browserLike: unknown): FlagStorageLike['storage'] {
  return (browserLike as FlagStorageLike | undefined)?.storage;
}

/** Module-scoped cache. Starts at the default budget until a read resolves. */
let cached: StoredEnrichCollected = {
  limit: DEFAULT_ENRICH_COLLECTED_LIMIT,
};
let subscribed = false;
/**
 * Bumped by every write. A `refreshEnrichCollected()` that started before a
 * write must not publish its (now stale) read when it finally resolves — the
 * worker's start-up read and a user toggling the switch can overlap.
 */
let epoch = 0;

function isLimit(value: unknown): value is EnrichCollectedLimit {
  return (
    typeof value === 'string' &&
    (ENRICH_COLLECTED_LIMIT_OPTIONS as readonly string[]).includes(value)
  );
}

/**
 * Normalises whatever was stored. A missing row, a corrupt value or a value
 * from a future version all fall back to the default instead of throwing.
 *
 * SAD-385: the stored value may still be SAD-379's `{ enabled, limit }`. The
 * only case that carries a *user's* intent is `enabled: true` — they switched
 * enrichment on and picked a budget — so that budget is kept. The factory
 * record (`enabled: false`, the old default) was never chosen by anybody and
 * falls through to the new default, `all`. A record with no `enabled` key at all
 * is the new writer's own shape and simply keeps its limit.
 */
export function readEnrichCollected(value: unknown): StoredEnrichCollected {
  if (!value || typeof value !== 'object') {
    return { limit: DEFAULT_ENRICH_COLLECTED_LIMIT };
  }
  const record = value as Record<string, unknown>;
  if (isLimit(record.limit) && record.enabled !== false) {
    return { limit: record.limit };
  }
  return { limit: DEFAULT_ENRICH_COLLECTED_LIMIT };
}

/** `'all'` → Infinity, `'25'` → 25, `'50'` → 50. */
export function resolveEnrichCollectedLimit(limit: EnrichCollectedLimit): number {
  return limit === 'all' ? Number.POSITIVE_INFINITY : Number(limit);
}

/**
 * Synchronous, cached read — cheap enough for every collection batch.
 *
 * `'all'` arrives here as `Number.POSITIVE_INFINITY`, so callers never branch on
 * a string.
 */
export function getEnrichCollectedLimit(): number {
  return resolveEnrichCollectedLimit(cached.limit);
}

/** The raw enum, for the Settings UI's radio group. */
export function getEnrichCollectedLimitSetting(): EnrichCollectedLimit {
  return cached.limit;
}

/**
 * One `storage.local.get`. A restricted context (no extension APIs, or a
 * rejected read) keeps the cache at its fail-closed default.
 */
export async function refreshEnrichCollected(
  browserLike: unknown = defaultBrowserLike(),
): Promise<void> {
  const startedAt = epoch;
  try {
    const local = storageOf(browserLike)?.local;
    if (typeof local?.get !== 'function') return;
    const stored = await local.get(ENRICH_COLLECTED_KEY);
    if (epoch !== startedAt) return; // a newer write already answered
    cached = readEnrichCollected(stored?.[ENRICH_COLLECTED_KEY]);
  } catch {
    if (epoch !== startedAt) return;
    cached = { limit: DEFAULT_ENRICH_COLLECTED_LIMIT };
  }
}

/**
 * The single writer (the Settings UI). The cache is updated even when storage
 * is unavailable, so tests and restricted pages behave consistently.
 */
export async function setEnrichCollectedLimit(
  limit: EnrichCollectedLimit,
  browserLike: unknown = defaultBrowserLike(),
): Promise<void> {
  const next: StoredEnrichCollected = { limit };
  epoch += 1;
  cached = next;
  try {
    await storageOf(browserLike)?.local?.set?.({ [ENRICH_COLLECTED_KEY]: next });
  } catch {
    // A storage write error must not break the caller: the cache is already set.
  }
}

/**
 * Keeps the cache in sync with `storage.onChanged`. Idempotent per context;
 * returns a disposer.
 */
export function subscribeEnrichCollected(
  browserLike: unknown = defaultBrowserLike(),
): () => void {
  const onChanged = storageOf(browserLike)?.onChanged;
  if (subscribed || typeof onChanged?.addListener !== 'function') {
    return () => {};
  }
  const listener: StorageListener = (changes, areaName) => {
    if (areaName !== 'local' || !changes) return;
    if (!(ENRICH_COLLECTED_KEY in changes)) return;
    epoch += 1;
    cached = readEnrichCollected(changes[ENRICH_COLLECTED_KEY]?.newValue);
  };
  onChanged.addListener(listener);
  subscribed = true;
  return () => {
    onChanged.removeListener?.(listener);
    subscribed = false;
  };
}

/** Test-only: restore the module to its startup state. */
export function resetEnrichCollectedForTests(): void {
  cached = { limit: DEFAULT_ENRICH_COLLECTED_LIMIT };
  subscribed = false;
  epoch = 0;
}
