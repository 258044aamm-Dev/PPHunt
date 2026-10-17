import { temuDb } from './database';
import { DEFAULT_TEMU_SETTINGS } from '../constants/defaults';
import { TemuSettingsSchema } from '../schemas/settings';
import type { TemuUserSettings } from '../types';

export type TemuSettingsUpdate = Partial<Omit<TemuUserSettings, 'id'>>;

export async function getTemuSettings(): Promise<TemuUserSettings> {
  const existing = await temuDb.settings.get(1);
  if (existing) {
    return TemuSettingsSchema.parse({
      ...DEFAULT_TEMU_SETTINGS,
      ...existing,
      id: 1,
    });
  }

  const initial: TemuUserSettings = { id: 1, ...DEFAULT_TEMU_SETTINGS };
  await temuDb.settings.put(initial);
  return initial;
}

export async function updateTemuSettings(
  partial: TemuSettingsUpdate
): Promise<TemuUserSettings> {
  const current = await getTemuSettings();
  const merged = TemuSettingsSchema.parse({
    ...DEFAULT_TEMU_SETTINGS,
    ...current,
    ...partial,
    id: 1,
  });
  await temuDb.settings.put(merged);
  return merged;
}

export async function resetTemuSettings(): Promise<TemuUserSettings> {
  const reset: TemuUserSettings = { id: 1, ...DEFAULT_TEMU_SETTINGS };
  await temuDb.settings.put(reset);
  return reset;
}
