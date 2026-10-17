import { temuDb } from './database';
import { DEFAULT_TEMU_SETTINGS } from '../constants/defaults';
import { TemuSettingsSchema } from '../schemas/settings';
import type { TemuSettings } from '../types';

export type TemuSettingsUpdate = Omit<
  Partial<TemuSettings>,
  'enabledFields' | 'scroll'
> & {
  enabledFields?: Partial<TemuSettings['enabledFields']>;
  scroll?: Partial<TemuSettings['scroll']>;
};

export async function getTemuSettings(): Promise<TemuSettings> {
  const existing = await temuDb.settings.get('default');
  if (existing) {
    return TemuSettingsSchema.parse({
      ...DEFAULT_TEMU_SETTINGS,
      ...existing,
      scroll: {
        ...DEFAULT_TEMU_SETTINGS.scroll,
        ...(existing.scroll ?? {}),
      },
      enabledFields: {
        ...DEFAULT_TEMU_SETTINGS.enabledFields,
        ...(existing.enabledFields ?? {}),
      },
    });
  }

  await temuDb.settings.put({ id: 'default', ...DEFAULT_TEMU_SETTINGS });
  return DEFAULT_TEMU_SETTINGS;
}

export async function updateTemuSettings(
  partial: TemuSettingsUpdate
): Promise<TemuSettings> {
  const current = await getTemuSettings();
  const merged = TemuSettingsSchema.parse({
    ...current,
    ...partial,
    scroll: {
      ...DEFAULT_TEMU_SETTINGS.scroll,
      ...current.scroll,
      ...(partial.scroll ?? {}),
    },
    enabledFields: {
      ...DEFAULT_TEMU_SETTINGS.enabledFields,
      ...current.enabledFields,
      ...(partial.enabledFields ?? {}),
    },
  });
  await temuDb.settings.put({ id: 'default', ...merged });
  return merged;
}

export async function resetTemuSettings(): Promise<TemuSettings> {
  await temuDb.settings.put({ id: 'default', ...DEFAULT_TEMU_SETTINGS });
  return DEFAULT_TEMU_SETTINGS;
}
