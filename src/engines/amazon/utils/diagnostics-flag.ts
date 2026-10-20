/**
 * SAD-369: the cached reader for the diagnostics switch
 * (`pphuntDiagnosticsEnabled`, see `constants/diagnostics.ts`).
 *
 * Mirrors the `content/card-action-theme.ts` pattern for the theme key: read
 * once, then keep the cache in sync with `storage.onChanged`, so flipping the
 * setting in one context takes effect in every other context without a page
 * reload.
 *
 * All access to the extension object is defensive and injectable, so the
 * behaviour is testable without a browser. The cache starts at
 * `DEFAULT_DIAGNOSTICS_ENABLED` (off — D1), so every context fails closed:
 * until the first read resolves, nothing is logged.
 */
import {
  DEFAULT_DIAGNOSTICS_ENABLED,
  DIAGNOSTICS_ENABLED_KEY,
  readDiagnosticsEnabled,
} from '../constants/diagnostics';

type StorageListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

interface DiagnosticsStorageLike {
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

/** Module-scoped cache. Starts OFF (D1): fail closed until the read resolves. */
let cached = DEFAULT_DIAGNOSTICS_ENABLED;
let subscribed = false;

function storageOf(browserLike: unknown): DiagnosticsStorageLike['storage'] {
  return (browserLike as DiagnosticsStorageLike | undefined)?.storage;
}

/** Synchronous, cached read — cheap enough for tight parse loops. */
export function getDiagnosticsEnabled(): boolean {
  return cached;
}

/**
 * One `storage.local.get`. A restricted context (no extension APIs, or a
 * rejected read) never breaks the caller: the cache falls back to OFF.
 */
export async function refreshDiagnosticsEnabled(
  browserLike: unknown = defaultBrowserLike(),
): Promise<void> {
  try {
    const local = storageOf(browserLike)?.local;
    if (typeof local?.get !== 'function') return;
    const stored = await local.get(DIAGNOSTICS_ENABLED_KEY);
    cached = readDiagnosticsEnabled(stored?.[DIAGNOSTICS_ENABLED_KEY]);
  } catch {
    // A restricted context must not break the page: stay off.
    cached = DEFAULT_DIAGNOSTICS_ENABLED;
  }
}

/**
 * The single writer (the Settings UI). The cache is set even when storage is
 * unavailable, so tests and restricted pages behave consistently.
 */
export async function setDiagnosticsEnabled(
  value: boolean,
  browserLike: unknown = defaultBrowserLike(),
): Promise<void> {
  cached = value;
  try {
    await storageOf(browserLike)?.local?.set?.({
      [DIAGNOSTICS_ENABLED_KEY]: value,
    });
  } catch {
    // A storage write error must not break the caller: the cache is already set.
  }
}

/**
 * Keeps the cache in sync with `storage.onChanged`, so the switch takes
 * effect without a page reload. Idempotent per context. Returns a disposer —
 * the content script calls it from `__PPHUNT_CONTENT_CLEANUP__`, otherwise
 * every navigation leaves a listener behind.
 */
export function subscribeDiagnosticsEnabled(
  browserLike: unknown = defaultBrowserLike(),
): () => void {
  const onChanged = storageOf(browserLike)?.onChanged;
  if (subscribed || typeof onChanged?.addListener !== 'function') {
    return () => {};
  }
  const listener: StorageListener = (changes, areaName) => {
    if (areaName !== 'local' || !changes) return;
    if (!(DIAGNOSTICS_ENABLED_KEY in changes)) return;
    cached = readDiagnosticsEnabled(changes[DIAGNOSTICS_ENABLED_KEY]?.newValue);
  };
  onChanged.addListener(listener);
  subscribed = true;
  return () => {
    onChanged.removeListener?.(listener);
    subscribed = false;
  };
}
