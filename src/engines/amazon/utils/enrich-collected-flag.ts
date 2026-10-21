/**
 * SAD-379: the cached reader for the collection enrichment switch.
 *
 * Mirrors the `utils/diagnostics-flag.ts` pattern (SAD-369): the two settings
 * are mirrored into `storage.local` so the service worker gets a *synchronous*
 * answer on the hot path (every `PRODUCTS_COLLECTED` batch), and
 * `storage.onChanged` keeps the cache live so flipping the switch in Settings
 * takes effect without a worker restart.
 *
 * Both values are read with a single `get`, so the hot path costs one storage
 * read rather than two.
 *
 * Everything is defensive and injectable: with no extension APIs (tests, a
 * restricted context) the cache keeps its defaults — OFF — so nothing is ever
 * enriched by accident.
 */
import {
  DEFAULT_ENRICH_COLLECTED,
  DEFAULT_ENRICH_COLLECTED_LIMIT,
  ENRICH_COLLECTED_LIMIT_OPTIONS,
  type EnrichCollectedLimit,
} from '../constants/defaults';

/** One `storage.local` key holding `{ enabled, limit }`. */
export const ENRICH_COLLECTED_KEY = 'pphuntEnrichCollected';

export interface EnrichCollectedSettings {
  /** Whether a collection run should enrich what it collected. */
  enabled: boolean;
  /**
   * How many products this run may enrich. `'all'` arrives here as
   * `Number.POSITIVE_INFINITY`, so callers never branch on a string.
   */
  limit: number;
}

export interface StoredEnrichCollected {
  enabled: boolean;
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

/** Module-scoped cache. Starts OFF (fail closed) until a read resolves. */
let cached: StoredEnrichCollected = {
  enabled: DEFAULT_ENRICH_COLLECTED,
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
 * from a future version all fall back to the defaults instead of throwing.
 */
export function readEnrichCollected(value: unknown): StoredEnrichCollected {
  if (!value || typeof value !== 'object') {
    return {
      enabled: DEFAULT_ENRICH_COLLECTED,
      limit: DEFAULT_ENRICH_COLLECTED_LIMIT,
    };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : DEFAULT_ENRICH_COLLECTED,
    limit: isLimit(record.limit) ? record.limit : DEFAULT_ENRICH_COLLECTED_LIMIT,
  };
}

/** `'all'` → Infinity, `'25'` → 25, `'50'` → 50. */
export function resolveEnrichCollectedLimit(limit: EnrichCollectedLimit): number {
  return limit === 'all' ? Number.POSITIVE_INFINITY : Number(limit);
}

/** Synchronous, cached read — cheap enough for every collection batch. */
export function getEnrichCollectedSettings(): EnrichCollectedSettings {
  return {
    enabled: cached.enabled,
    limit: resolveEnrichCollectedLimit(cached.limit),
  };
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
    cached = {
      enabled: DEFAULT_ENRICH_COLLECTED,
      limit: DEFAULT_ENRICH_COLLECTED_LIMIT,
    };
  }
}

/**
 * The single writer (the Settings UI). The cache is updated even when storage
 * is unavailable, so tests and restricted pages behave consistently.
 */
export async function setEnrichCollectedSettings(
  settings: Partial<StoredEnrichCollected>,
  browserLike: unknown = defaultBrowserLike(),
): Promise<void> {
  const next = readEnrichCollected({ ...cached, ...settings });
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
  cached = {
    enabled: DEFAULT_ENRICH_COLLECTED,
    limit: DEFAULT_ENRICH_COLLECTED_LIMIT,
  };
  subscribed = false;
  epoch = 0;
}
