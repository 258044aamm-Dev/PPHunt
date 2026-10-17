import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DEFAULT_ENABLED_FIELDS } from '../../constants/defaults';
import { db } from '../../db/database';
import {
  getSettings,
  resetSettings,
  updateSettings as persistSettings,
  type SettingsUpdate,
} from '../../db/settings';
import { SettingsSchema } from '../../schemas/settings';
import type { AppSettings, EnabledFieldsConfig } from '../../types';

export const SAVE_DEBOUNCE_MS = 500;

export interface UseSettingsOptions {
  saveDebounceMs?: number;
}

/**
 * React hook for live-querying and debounced-updating Amazon settings in `PPHuntDB`.
 * Queues rapid scalar and `enabledFields` updates across debounce windows so fast
 * checkbox toggles or slider drags never drop earlier keys.
 */
export function useAmazonSettings(options: UseSettingsOptions = {}) {
  const saveDebounceMs = options.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
  const rawSettings = useLiveQuery(() => db.settings.get('default'), []);
  const [optimisticTick, setOptimisticTick] = useState(0);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScalarsRef = useRef<Omit<SettingsUpdate, 'enabledFields'>>({});
  const pendingEnabledFieldsRef = useRef<Partial<EnabledFieldsConfig>>({});
  const baseEnabledFieldsRef = useRef<EnabledFieldsConfig>({
    ...DEFAULT_ENABLED_FIELDS,
  });

  useEffect(() => {
    void getSettings().catch((err) => {
      console.error('[PPHunt] Settings initialization error:', err);
    });
  }, []);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const dbParsed = useMemo<AppSettings | null>(() => {
    if (!rawSettings) return null;

    const mergedCandidate = {
      ...rawSettings,
      id: 'default' as const,
      enabledFields: {
        ...DEFAULT_ENABLED_FIELDS,
        ...(rawSettings.enabledFields ?? {}),
      },
    };

    const result = SettingsSchema.safeParse(mergedCandidate);
    if (result.success) {
      baseEnabledFieldsRef.current = { ...result.data.enabledFields };
      return result.data;
    }

    console.error(
      '[PPHunt] Stored settings are invalid; falling back to defaults',
      result.error.issues,
    );
    const fallback = SettingsSchema.parse({});
    baseEnabledFieldsRef.current = { ...fallback.enabledFields };
    return fallback;
  }, [rawSettings]);

  const settings = useMemo<AppSettings | null>(() => {
    if (!dbParsed) return null;
    const pendingScalars = pendingScalarsRef.current;
    const pendingFields = pendingEnabledFieldsRef.current;
    if (
      Object.keys(pendingScalars).length === 0 &&
      Object.keys(pendingFields).length === 0
    ) {
      return dbParsed;
    }
    return {
      ...dbParsed,
      ...pendingScalars,
      enabledFields: {
        ...dbParsed.enabledFields,
        ...pendingFields,
      },
    };
  }, [dbParsed, optimisticTick]);

  const updateSettings = useCallback(
    (partial: SettingsUpdate) => {
      const { enabledFields, ...scalars } = partial;

      if (Object.keys(scalars).length > 0) {
        pendingScalarsRef.current = {
          ...pendingScalarsRef.current,
          ...scalars,
        };
      }

      if (enabledFields) {
        const base = baseEnabledFieldsRef.current;
        const diff: Partial<EnabledFieldsConfig> = {};
        for (const key of Object.keys(enabledFields) as Array<
          keyof EnabledFieldsConfig
        >) {
          const val = enabledFields[key];
          if (typeof val === 'boolean' && val !== base[key]) {
            diff[key] = val;
          }
        }
        // Only if the caller passed a partial object (fewer keys than full config), merge directly
        if (
          Object.keys(diff).length === 0 &&
          Object.keys(enabledFields).length <
            Object.keys(DEFAULT_ENABLED_FIELDS).length
        ) {
          Object.assign(diff, enabledFields);
        }
        pendingEnabledFieldsRef.current = {
          ...pendingEnabledFieldsRef.current,
          ...diff,
        };
      }

      setOptimisticTick((t) => t + 1);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const scalarsToSave = pendingScalarsRef.current;
        const fieldsToSave = pendingEnabledFieldsRef.current;
        pendingScalarsRef.current = {};
        pendingEnabledFieldsRef.current = {};

        const hasScalars = Object.keys(scalarsToSave).length > 0;
        const hasFields = Object.keys(fieldsToSave).length > 0;
        if (!hasScalars && !hasFields) return;

        const payload: SettingsUpdate = {
          ...scalarsToSave,
          ...(hasFields ? { enabledFields: fieldsToSave } : {}),
        };

        try {
          const saved = await persistSettings(payload);
          baseEnabledFieldsRef.current = { ...saved.enabledFields };
          setOptimisticTick((t) => t + 1);
        } catch (err) {
          console.error('[PPHunt] Settings save error:', err);
        }
      }, saveDebounceMs);
    },
    [saveDebounceMs],
  );

  const restoreDefaults = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingScalarsRef.current = {};
    pendingEnabledFieldsRef.current = {};
    const defaults = await resetSettings();
    baseEnabledFieldsRef.current = { ...defaults.enabledFields };
    setOptimisticTick((t) => t + 1);
  }, []);

  return {
    settings,
    isLoading: rawSettings === undefined,
    updateSettings,
    restoreDefaults,
  };
}

export { useAmazonSettings as useSettings };
