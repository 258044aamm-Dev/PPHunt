export const TARGET_QUICK_SELECT = [50, 100, 200, 300] as const;

export const TARGET_MIN = 1;
export const TARGET_MAX = 1000;

/**
 * L-1 (SAD-197): single clamp shared by the store, the settings input and the
 * session-creation path, so 0 / negatives / 999999999 / NaN can never reach
 * code that divides by targetCount (progress bar, scroll controller).
 * Non-finite input falls back to the default; fractions round to the nearest
 * integer (targetCount is a product count).
 */
export function clampTargetCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TARGET_COUNT;
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(value)));
}

// Export defaults (SAD-167): single source shared by the settings schema and
// the export UI, matching the app's behaviour before settings were wired.
export const DEFAULT_EXPORT_FORMAT = 'csv' as const;
export const DEFAULT_INCLUDE_BOM = true;
/**
 * M-6 (SAD-192) decision D4: image embedding default. 'auto' embeds only
 * within the size/time budgets; 'always'/'never' override per user choice.
 */
export const DEFAULT_EXPORT_IMAGES = 'auto' as const;

export const SCROLL_SPEED_MIN = 100;
export const SCROLL_SPEED_MAX = 3000;
export const SCROLL_INTERVAL_MIN = 200;
export const SCROLL_INTERVAL_MAX = 5000;
export const WAIT_AFTER_SCROLL_MIN = 500;
export const WAIT_AFTER_SCROLL_MAX = 10000;
/** Default collection target (TargetSelector default + session rows). */
export const DEFAULT_TARGET_COUNT = 50;

/** Cap for the existingAsins pre-seed array on COLLECT_PRODUCTS (Step 4.4). */
export const MAX_SEEDED_ASINS = 2000;
