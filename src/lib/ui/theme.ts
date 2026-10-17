/**
 * Theme management for PPHunt (Side Panel, Page Overlay, and Chooser Popup).
 * Supports 'system' (default), 'light', and 'dark' modes with live cross-context sync.
 */
export const THEME_MODE_KEY = 'pphuntTheme';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface StorageAreaLike {
  get?: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
  set?: (items: Record<string, unknown>) => Promise<void>;
  remove?: (keys: string | string[]) => Promise<void>;
}

interface ExtensionBrowserLike {
  storage?: {
    local?: StorageAreaLike;
    onChanged?: {
      addListener?: (callback: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void) => void;
      removeListener?: (callback: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void) => void;
    };
  };
}

function getExtensionBrowser(): ExtensionBrowserLike | undefined {
  const g = globalThis as unknown as { browser?: ExtensionBrowserLike; chrome?: ExtensionBrowserLike };
  return g.browser ?? g.chrome;
}

export function readThemeMode(value: unknown): ThemeMode {
  if (value === 'light' || value === 'dark' || value === 'system') {
    return value;
  }
  return 'system';
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }
  return 'light';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') {
    return mode;
  }
  return getSystemTheme();
}

export function applyTheme(
  mode: ThemeMode,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null
): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (root) {
    root.classList.toggle('dark', resolved === 'dark');
    root.dataset.theme = resolved;
    root.dataset.themeMode = mode;
    root.style.colorScheme = resolved;
  }
  return resolved;
}

export async function setThemePreference(mode: ThemeMode): Promise<ResolvedTheme> {
  const resolved = applyTheme(mode);
  const ext = getExtensionBrowser();
  const local = ext?.storage?.local;
  if (local) {
    try {
      if (mode === 'system' && typeof local.remove === 'function') {
        await local.remove(THEME_MODE_KEY);
      } else if (typeof local.set === 'function') {
        await local.set({ [THEME_MODE_KEY]: mode });
      }
    } catch {
      // Ignore storage write errors in restricted or test contexts.
    }
  }
  return resolved;
}

/**
 * Synchronizes the document theme with saved extension storage and OS color scheme changes.
 * Returns a cleanup function that unsubscribes all listeners.
 */
export function initThemeSync(
  onUpdate?: (mode: ThemeMode, resolved: ResolvedTheme) => void
): () => void {
  let currentMode: ThemeMode = 'system';
  let hasExternalUpdate = false;
  let disposed = false;

  const notify = (mode: ThemeMode) => {
    currentMode = mode;
    const resolved = applyTheme(mode);
    onUpdate?.(mode, resolved);
  };

  // Apply initial default immediately to prevent flash of unstyled theme.
  notify(currentMode);

  const ext = getExtensionBrowser();
  const local = ext?.storage?.local;
  if (local?.get) {
    void Promise.resolve(local.get(THEME_MODE_KEY))
      .then((stored) => {
        if (disposed || hasExternalUpdate) return;
        notify(readThemeMode(stored?.[THEME_MODE_KEY]));
      })
      .catch(() => {});
  }

  const onStorageChanged = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string
  ) => {
    if (areaName !== 'local' || !(THEME_MODE_KEY in changes)) return;
    hasExternalUpdate = true;
    notify(readThemeMode(changes[THEME_MODE_KEY]?.newValue));
  };

  ext?.storage?.onChanged?.addListener?.(onStorageChanged);

  let mediaQuery: MediaQueryList | null = null;
  const onMediaChange = () => {
    if (currentMode === 'system') {
      notify('system');
    }
  };

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQuery.addEventListener?.('change', onMediaChange);
    } catch {
      mediaQuery = null;
    }
  }

  return () => {
    disposed = true;
    ext?.storage?.onChanged?.removeListener?.(onStorageChanged);
    mediaQuery?.removeEventListener?.('change', onMediaChange);
  };
}
