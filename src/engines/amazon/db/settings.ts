import {
  DEFAULT_AMAZON_SETTINGS,
  DEFAULT_ENABLED_FIELDS,
} from '../constants/defaults';
import { SettingsSchema } from '../schemas/settings';
import type { AppSettings, EnabledFieldsConfig } from '../types';
import { db } from './database';

let settingsWriteQueue: Promise<unknown> = Promise.resolve();

/**
 * Validates a raw settings record from IndexedDB, merging `enabledFields` with defaults.
 * Logs an error and degrades gracefully to schema defaults if the stored row is invalid.
 */
export function parseStoredSettingsSafe(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') {
    return SettingsSchema.parse({});
  }

  const record = raw as Partial<AppSettings>;
  const mergedCandidate = {
    ...record,
    id: 'default',
    enabledFields: {
      ...DEFAULT_ENABLED_FIELDS,
      ...(record.enabledFields && typeof record.enabledFields === 'object'
        ? record.enabledFields
        : {}),
    },
  };

  const parsed = SettingsSchema.safeParse(mergedCandidate);
  if (!parsed.success) {
    console.error(
      '[PPHunt] Stored settings are invalid; falling back to defaults',
      parsed.error,
    );
    return SettingsSchema.parse({});
  }

  return parsed.data;
}

/**
 * Reads the current `AppSettings` from IndexedDB (`id = 'default'`), seeding defaults if absent
 * and degrading gracefully to defaults if malformed.
 */
export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get('default');
  if (!row) {
    const defaults = SettingsSchema.parse({});
    try {
      await db.settings.put(defaults);
    } catch {
      // Ignore read-only/closed DB during teardown
    }
    return defaults;
  }

  return parseStoredSettingsSafe(row);
}

export type SettingsUpdate = Partial<Omit<AppSettings, 'enabledFields'>> & {
  enabledFields?: Partial<EnabledFieldsConfig>;
};

/**
 * Deep-merges a partial settings update into the stored `default` row inside a serialized write queue
 * so rapid concurrent toggles never clobber sibling keys.
 */
export function updateSettings(
  partial: SettingsUpdate,
): Promise<AppSettings> {
  const nextOp = settingsWriteQueue.then(async () => {
    const currentRaw = await db.settings.get('default');
    const current = currentRaw
      ? parseStoredSettingsSafe(currentRaw)
      : SettingsSchema.parse({});

    const nextCandidate: AppSettings = {
      ...current,
      ...partial,
      id: 'default',
      enabledFields: {
        ...DEFAULT_ENABLED_FIELDS,
        ...current.enabledFields,
        ...(partial.enabledFields ?? {}),
      },
    };

    const validated = parseStoredSettingsSafe(nextCandidate);
    await db.settings.put(validated);
    return validated;
  });

  settingsWriteQueue = nextOp.catch(() => {});
  return nextOp;
}

/**
 * Resets the stored settings row back to clean factory defaults.
 */
export function resetSettings(): Promise<AppSettings> {
  const nextOp = settingsWriteQueue.then(async () => {
    const defaults: AppSettings = {
      ...DEFAULT_AMAZON_SETTINGS,
      id: 'default',
      enabledFields: { ...DEFAULT_ENABLED_FIELDS },
    };
    await db.settings.put(defaults);
    return defaults;
  });

  settingsWriteQueue = nextOp.catch(() => {});
  return nextOp;
}

export const restoreDefaultSettings = resetSettings;
