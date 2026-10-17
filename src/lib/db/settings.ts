import { db } from './database';
import {
  DEFAULT_ENABLED_FIELDS,
  SettingsSchema,
  type ValidatedSettings,
} from '@/lib/schemas/settings';

const DEFAULT_SETTINGS: ValidatedSettings = SettingsSchema.parse({});

/**
 * A partial settings update. `enabledFields` may be a PARTIAL map —
 * `updateSettings` deep-merges it over `DEFAULT_ENABLED_FIELDS` and the
 * current row, which is what lets UI callers send single-key or diff-based
 * field patches (SAD-168). Existing callers passing complete objects remain
 * valid: the full shape is assignable to the partial one.
 */
export type SettingsUpdate = Omit<Partial<ValidatedSettings>, 'enabledFields'> & {
  enabledFields?: Partial<ValidatedSettings['enabledFields']>;
};

export async function getSettings(): Promise<ValidatedSettings> {
  const existing = await db.settings.get('default');
  if (existing) {
    return SettingsSchema.parse({
      ...existing,
      enabledFields: {
        ...DEFAULT_ENABLED_FIELDS,
        ...(existing.enabledFields ?? {}),
      },
    });
  }
  await db.settings.put(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function updateSettings(
  partial: SettingsUpdate
): Promise<ValidatedSettings> {
  const current = await getSettings();
  const merged = SettingsSchema.parse({
    ...current,
    ...partial,
    enabledFields: {
      ...DEFAULT_ENABLED_FIELDS,
      ...current.enabledFields,
      ...(partial.enabledFields ?? {}),
    },
  });
  await db.settings.put(merged);
  return merged;
}

