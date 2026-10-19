/**
 * SAD-331 — keep the per-card save control on the user's PPHunt theme.
 *
 * The control lives in a closed shadow root, so it cannot inherit the page's
 * colours and it does not see the side panel's theme. Historically it was styled
 * only by `@media (prefers-color-scheme: dark)`, i.e. it followed the operating
 * system instead of the extension's own setting.
 *
 * This module reads `pphuntTheme` from `storage.local`, pushes the matching
 * palette into every mounted control, and keeps them in sync while the listing
 * stays open. Reading, writing and the listener are injectable so the behaviour
 * is testable without a browser.
 */
import { readThemeMode, THEME_MODE_KEY, type ThemeMode } from '@/lib/ui/theme';

/** What the control's stylesheet understands. `auto` = follow the OS. */
export type CardActionTheme = 'light' | 'dark' | 'auto';

/**
 * `system` is passed through as `auto` rather than resolved here: the control's
 * own `@media` rule then reacts to an OS change without another round trip.
 */
export function toCardActionTheme(mode: ThemeMode): CardActionTheme {
  return mode === 'system' ? 'auto' : mode;
}

interface StorageListener {
  (changes: Record<string, { newValue?: unknown }>, areaName: string): void;
}

interface ThemeStorageLike {
  storage?: {
    local?: { get?: (keys: string) => Promise<Record<string, unknown>> };
    onChanged?: {
      addListener?: (listener: StorageListener) => void;
      removeListener?: (listener: StorageListener) => void;
    };
  };
}

export interface ThemeTarget {
  setTheme: (theme: CardActionTheme) => void;
}

/**
 * Applies the stored theme now and on every later change.
 *
 * Returns a disposer. Call it from `__PPHUNT_CONTENT_CLEANUP__`, otherwise every
 * navigation leaves a listener behind and the stack grows for the tab's life.
 */
export function syncCardActionTheme(
  target: ThemeTarget,
  browserLike: unknown = (globalThis as { browser?: unknown; chrome?: unknown })
    .browser ?? (globalThis as { chrome?: unknown }).chrome,
): () => void {
  const storage = (browserLike as ThemeStorageLike | undefined)?.storage;
  const local = storage?.local;
  const onChanged = storage?.onChanged;

  const apply = (raw: unknown): void => {
    target.setTheme(toCardActionTheme(readThemeMode(raw)));
  };

  const listener: StorageListener = (changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes || !(THEME_MODE_KEY in changes)) return;
    apply(changes[THEME_MODE_KEY]?.newValue);
  };

  if (local && typeof local.get === 'function') {
    void Promise.resolve(local.get(THEME_MODE_KEY))
      .then((stored) => apply(stored?.[THEME_MODE_KEY]))
      .catch(() => {
        // A restricted context must not break the listing page: fall back to
        // the stylesheet's own `prefers-color-scheme` behaviour.
      });
  }

  const canListen = typeof onChanged?.addListener === 'function';
  if (canListen) onChanged?.addListener?.(listener);

  return () => {
    if (canListen) onChanged?.removeListener?.(listener);
  };
}
