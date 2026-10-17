import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DEFAULT_TEMU_SETTINGS } from '../../constants/defaults';
import { temuDb } from '../../db/database';
import {
  getTemuSettings,
  resetTemuSettings,
  updateTemuSettings as persistTemuSettings,
  type TemuSettingsUpdate,
} from '../../db/settings';
import { TemuSettingsSchema } from '../../schemas/settings';
import type { TemuUserSettings } from '../../types';

export const TEMU_SAVE_DEBOUNCE_MS = 500;

export function useTemuSettings(saveDebounceMs = TEMU_SAVE_DEBOUNCE_MS) {
  const settings = useLiveQuery(() => temuDb.settings.get(1), []);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TemuSettingsUpdate | null>(null);

  useEffect(() => {
    void getTemuSettings().catch((err) => {
      console.error('[PPHunt:Temu] Settings initialization error:', err);
    });
  }, []);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    []
  );

  const parsed = useMemo<TemuUserSettings | null>(() => {
    if (!settings) return null;
    const result = TemuSettingsSchema.safeParse({
      ...DEFAULT_TEMU_SETTINGS,
      ...settings,
      id: 1,
    });
    if (result.success) return result.data;
    return { id: 1, ...DEFAULT_TEMU_SETTINGS };
  }, [settings]);

  const updateSettings = useCallback(
    (partial: TemuSettingsUpdate) => {
      pendingRef.current = { ...(pendingRef.current ?? {}), ...partial };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!pending || Object.keys(pending).length === 0) return;
        try {
          await persistTemuSettings(pending);
        } catch (err) {
          console.error('[PPHunt:Temu] Settings save error:', err);
        }
      }, saveDebounceMs);
    },
    [saveDebounceMs]
  );

  const restoreDefaults = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    pendingRef.current = null;
    await resetTemuSettings();
  }, []);

  return {
    settings: parsed,
    isLoading: settings === undefined,
    updateSettings,
    restoreDefaults,
  };
}
