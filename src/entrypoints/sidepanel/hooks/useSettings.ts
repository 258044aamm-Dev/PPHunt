import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/database';
import {
  DEFAULT_ENABLED_FIELDS,
  SettingsSchema,
  type ValidatedSettings,
} from '@/lib/schemas/settings';
import {
  getSettings,
  updateSettings as persistSettings,
  type SettingsUpdate,
} from '@/lib/db/settings';

export const SAVE_DEBOUNCE_MS = 500;

export interface UseSettingsOptions {
  /**
   * Debounce window for saves. Exported for tests (SAD-168): assertions
   * should not depend on the 500 ms production wall clock.
   */
  saveDebounceMs?: number;
}

type Pending = SettingsUpdate;

/**
 * Extracts only the keys whose value differs from the row the caller last
 * rendered (`row`). SettingsOverlay checkbox handlers send *complete*
 * `enabledFields` snapshots built from that row, and inside one debounce
 * window the row is stale — so the untouched keys in a snapshot are echoes
 * of the old row, not user intent. Diffing keeps intent and drops echoes.
 * With no row loaded yet, everything is treated as intent.
 */
function buildDelta(partial: Pending, row: ValidatedSettings | null): Pending {
  if (!row) return { ...partial };
  const delta: Pending = {};
  for (const key of Object.keys(partial) as Array<keyof Pending>) {
    if (key === 'enabledFields') continue;
    if (!Object.is(partial[key], row[key])) {
      (delta as Record<string, unknown>)[key] = partial[key];
    }
  }
  if (partial.enabledFields) {
    const baseFields = row.enabledFields as Record<string, boolean | undefined>;
    const fields: Pending['enabledFields'] = {};
    for (const [field, value] of Object.entries(partial.enabledFields)) {
      if (baseFields[field] !== value) {
        (fields as Record<string, boolean>)[field] = value;
      }
    }
    if (Object.keys(fields).length > 0) delta.enabledFields = fields;
  }
  return delta;
}

/** Accumulates pending edits, deep-merging the nested `enabledFields` map. */
function mergePending(prev: Pending | null, delta: Pending): Pending {
  if (!prev) return { ...delta };
  const merged: Pending = { ...prev, ...delta };
  if (prev.enabledFields || delta.enabledFields) {
    merged.enabledFields = { ...prev.enabledFields, ...delta.enabledFields };
  }
  return merged;
}

/**
 * Hook for reading and writing settings.
 *
 * - `settings` — live-updated settings object (or null while loading)
 * - `isLoading` — true until first DB read completes
 * - `updateSettings(partial)` — merge partial update into existing, validate, write
 * - `restoreDefaults()` — reset to schema defaults
 */
export function useSettings(options: UseSettingsOptions = {}) {
  const { saveDebounceMs = SAVE_DEBOUNCE_MS } = options;
  const settings = useLiveQuery(() => db.settings.get('default'), []);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  // Last row the component tree rendered — the base the UI's snapshots were
  // built from. Kept in a ref so `updateSettings` stays referentially stable.
  const rowRef = useRef<ValidatedSettings | null>(null);

  // First launch: initialize defaults outside the read-only live query.
  // The write notifies useLiveQuery and opens the form once the record exists.
  useEffect(() => {
    void getSettings().catch((err) => {
      console.error('[PPHunt] Settings initialization error:', err);
    });
  }, []);

  // H-4 (SAD-168): never leave a debounce timer dangling past unmount.
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    []
  );

  // M-10 (SAD-169): never throw during render. Mirrors the enabledFields
  // merge in db/settings.ts#getSettings so both read paths tolerate the same
  // rows; a malformed row degrades to schema defaults and logs loudly instead
  // of white-screening the panel.
  const parsed = useMemo<ValidatedSettings | null>(() => {
    if (!settings) return null;
    const result = SettingsSchema.safeParse({
      ...settings,
      enabledFields: {
        ...DEFAULT_ENABLED_FIELDS,
        ...(settings.enabledFields ?? {}),
      },
    });
    if (result.success) return result.data;
    console.error(
      '[PPHunt] Stored settings are invalid; falling back to defaults',
      result.error.issues
    );
    return SettingsSchema.parse({});
  }, [settings]);
  rowRef.current = parsed;

  const updateSettings = useCallback(
    (partial: Pending) => {
      // H-4 (SAD-168): accumulate rather than replace. Three fixes in one:
      // 1. rapid partials no longer evict each other from the debounce window
      //    (they merge into pendingRef);
      // 2. stale full-object snapshots from the render closure are diffed
      //    against the rendered row, so they cannot resurrect old values;
      // 3. persistence is delegated to db/settings.ts#updateSettings, which
      //    re-reads the current row and deep-merges enabledFields.
      pendingRef.current = mergePending(
        pendingRef.current,
        buildDelta(partial, rowRef.current)
      );

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!pending || Object.keys(pending).length === 0) return;
        try {
          await persistSettings(pending);
        } catch (err) {
          console.error('[PPHunt] Settings save error:', err);
        }
      }, saveDebounceMs);
    },
    [saveDebounceMs]
  );

  const restoreDefaults = useCallback(async () => {
    // Drop any queued partials so a pending debounce cannot clobber the
    // restore half a second later.
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    pendingRef.current = null;
    const defaults = SettingsSchema.parse({});
    await db.settings.put(defaults);
  }, []);

  return {
    settings: parsed,
    isLoading: settings === undefined,
    updateSettings,
    restoreDefaults,
  };
}
