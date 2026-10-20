/**
 * SAD-369: the switch that turns the per-field extraction diagnostics on.
 *
 * It lives in `browser.storage.local`, not in the IndexedDB settings row,
 * because a content script cannot read the extension's IndexedDB — it runs in
 * the page's origin. `storage.local` is readable from every extension context
 * *and* from the content script, exactly like `pphuntTheme`
 * (`src/lib/ui/theme.ts`). One key, one writer (the Settings UI), read by the
 * content script, the service worker and every extension page.
 */
export const DIAGNOSTICS_ENABLED_KEY = 'pphuntDiagnosticsEnabled';

/** SAD-369 D1: off until the owner turns it on — a fresh install logs nothing. */
export const DEFAULT_DIAGNOSTICS_ENABLED = false;

/**
 * Only a literal `true` enables the diagnostics. A missing key, `undefined`
 * or any other value is `false` — a corrupt value must never turn logging on
 * by accident (fail closed).
 */
export function readDiagnosticsEnabled(raw: unknown): boolean {
  return raw === true;
}
