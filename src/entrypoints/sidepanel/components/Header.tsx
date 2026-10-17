import { useEffect, useState, useCallback } from 'react';
import { useUIStore } from '../store/uiStore';
import {
  initThemeSync,
  setThemePreference,
  type ResolvedTheme,
} from '@/lib/ui/theme';

/**
 * PPHunt header with brand wordmark, theme toggle, and settings gear icon.
 * Uses Lora serif for the brand name per PPHunt design spec.
 */
export function Header({ onClose }: { onClose?: () => void } = {}) {
  const openSettings = useUIStore((s) => s.openSettings);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'
  );

  useEffect(() => {
    return initThemeSync((_mode, resolved) => {
      setResolvedTheme(resolved);
    });
  }, []);

  const handleToggleTheme = useCallback(() => {
    const next: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    setResolvedTheme(next);
    void setThemePreference(next);
  }, [resolvedTheme]);

  const isDark = resolvedTheme === 'dark';

  return (
    <header className="flex items-center justify-between mb-3">
      <h1 className="font-serif text-xl font-semibold text-ink tracking-tight">
        PPHunt
      </h1>
      <div className="flex items-center gap-1">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay transition-colors"
            aria-label="Close overlay"
            title="Close overlay"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={handleToggleTheme}
          className="w-8 h-8 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay transition-colors"
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="w-8 h-8 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay transition-colors"
          aria-label="Settings"
          title="Settings"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
