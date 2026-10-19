/**
 * SAD-334 — one-time, user-reversible migration for the
 * `description` / `features` defaults.
 *
 * An install that predates SAD-333 stores `false` for both flags, and a stored
 * `false` always wins over the default. These tests pin the upgrade trigger
 * (`settingsVersion < 1`), its one-time nature, the fields it must not touch,
 * and the ways it must stay out of the way (current rows, malformed rows,
 * deliberate user choices).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_AMAZON_SETTINGS,
} from '@/engines/amazon/constants/defaults';
import {
  getSettings,
  resetSettings,
  updateSettings,
  upgradeStoredSettings,
} from '@/engines/amazon/db/settings';
import { db } from '@/lib/db/database';
import type { AppSettings } from '@/engines/amazon/types';

/** A row exactly as an older build would have written it: no version marker. */
function legacyRow(overrides: Partial<AppSettings> = {}) {
  const { settingsVersion: _drop, ...withoutVersion } = DEFAULT_AMAZON_SETTINGS;
  return {
    ...withoutVersion,
    ...overrides,
    enabledFields: {
      ...DEFAULT_AMAZON_SETTINGS.enabledFields,
      description: false,
      features: false,
      ...(overrides.enabledFields ?? {}),
    },
  } as unknown as AppSettings;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('SAD-334: settings migration', () => {
  it('flips both flags once on an old-default row and stamps the version', async () => {
    await db.settings.put(legacyRow());

    const settings = await getSettings();

    expect(settings.enabledFields.description).toBe(true);
    expect(settings.enabledFields.features).toBe(true);
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);

    // The rewrite is persisted, not just returned.
    const stored = await db.settings.get('default');
    expect(stored?.enabledFields.description).toBe(true);
    expect(stored?.enabledFields.features).toBe(true);
    expect(stored?.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('is idempotent: a second read does not write the row again', async () => {
    await db.settings.put(legacyRow());
    await getSettings();

    const put = vi.spyOn(db.settings, 'put');
    const second = await getSettings();

    expect(put).not.toHaveBeenCalled();
    expect(second.enabledFields.description).toBe(true);
    expect(second.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    put.mockRestore();
  });

  it('changes only the two flags: every other stored value survives untouched', async () => {
    const before = legacyRow({
      defaultTargetCount: 250,
      scrollSpeed: 1500,
      duplicateDetection: false,
      exportFormat: 'excel',
      exportFilename: 'my-list',
      notifications: false,
      quickSaveCollectionBehavior: 'ask',
    });
    const stored = {
      ...before,
      enabledFields: {
        ...before.enabledFields,
        price: false,
        rating: false,
      },
    } as unknown as AppSettings;
    await db.settings.put(stored);

    const settings = await getSettings();

    // The deliberately-off siblings stay off.
    expect(settings.enabledFields.price).toBe(false);
    expect(settings.enabledFields.rating).toBe(false);
    expect(settings.defaultTargetCount).toBe(250);
    expect(settings.scrollSpeed).toBe(1500);
    expect(settings.duplicateDetection).toBe(false);
    expect(settings.exportFormat).toBe('excel');
    expect(settings.exportFilename).toBe('my-list');
    expect(settings.notifications).toBe(false);
    expect(settings.quickSaveCollectionBehavior).toBe('ask');

    // Everything else in enabledFields is byte-identical to what was stored.
    const { description: _d, features: _f, ...storedRest } = stored.enabledFields;
    const { description: _d2, features: _f2, ...afterRest } = settings.enabledFields;
    expect(afterRest).toEqual(storedRest);
  });

  it('is a no-op on a row that already carries the current version', async () => {
    await db.settings.put({
      ...legacyRow(),
      settingsVersion: CURRENT_SETTINGS_VERSION,
    } as AppSettings);

    const put = vi.spyOn(db.settings, 'put');
    const settings = await getSettings();

    expect(put).not.toHaveBeenCalled();
    expect(settings.enabledFields.description).toBe(false);
    expect(settings.enabledFields.features).toBe(false);
    put.mockRestore();
  });

  it('stamps the version without flipping when only one of the two was off', async () => {
    await db.settings.put(
      legacyRow({
        enabledFields: { ...DEFAULT_ENABLED_FIELDS_DESCRIPTION_ON },
      } as unknown as Partial<AppSettings>),
    );

    const settings = await getSettings();

    expect(settings.enabledFields.description).toBe(true);
    expect(settings.enabledFields.features).toBe(false);
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('degrades a malformed row to defaults and never rewrites it', async () => {
    await db.settings.put({
      id: 'default',
      defaultTargetCount: 999999,
      enabledFields: {},
    } as unknown as AppSettings);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const put = vi.spyOn(db.settings, 'put');
    const settings = await getSettings();

    expect(put).not.toHaveBeenCalled();
    expect(settings.enabledFields.description).toBe(true);
    expect(settings.enabledFields.features).toBe(true);
    expect(errorSpy).toHaveBeenCalled();

    // The corrupt row is still there, exactly as before SAD-334.
    const stored = await db.settings.get('default');
    expect((stored as unknown as { defaultTargetCount: number }).defaultTargetCount).toBe(
      999999,
    );

    put.mockRestore();
    errorSpy.mockRestore();
  });

  it('keeps a column off when the user turns it off after the migration', async () => {
    await db.settings.put(legacyRow());
    await getSettings();

    await updateSettings({ enabledFields: { description: false } });

    const settings = await getSettings();
    expect(settings.enabledFields.description).toBe(false);
    expect(settings.enabledFields.features).toBe(true);
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('lets an explicit update on a legacy row win over the migration default', async () => {
    await db.settings.put(legacyRow());

    // One write that turns a different field: the row is upgraded, both flags
    // move to the new default, and the version is stamped by that same write.
    const updated = await updateSettings({ defaultTargetCount: 120 });
    expect(updated.enabledFields.description).toBe(true);
    expect(updated.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);

    // An explicit false in the same update is honoured, not overridden.
    const bothOff = await updateSettings({
      enabledFields: { description: false, features: false },
    });
    expect(bothOff.enabledFields.description).toBe(false);
    expect(bothOff.enabledFields.features).toBe(false);

    // ...and it stays off across a fresh read.
    const settings = await getSettings();
    expect(settings.enabledFields.description).toBe(false);
    expect(settings.enabledFields.features).toBe(false);
  });

  it('seeds a fresh install already current, so a later toggle-off is never undone', async () => {
    const seeded = await getSettings();
    expect(seeded.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(seeded.enabledFields.description).toBe(true);

    // A brand-new user turns both off before ever migrating.
    await updateSettings({ enabledFields: { description: false, features: false } });

    const settings = await getSettings();
    expect(settings.enabledFields.description).toBe(false);
    expect(settings.enabledFields.features).toBe(false);
  });

  it('reset writes factory defaults stamped with the current version', async () => {
    await db.settings.put(legacyRow());
    await getSettings();

    const reset = await resetSettings();
    expect(reset.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(reset.enabledFields.description).toBe(true);
    expect(reset.enabledFields.features).toBe(true);
  });

  it('upgradeStoredSettings is pure and reports whether a write is needed', () => {
    const legacy = legacyRow();
    const first = upgradeStoredSettings(legacy);
    expect(first.needsWrite).toBe(true);
    expect(first.settings.enabledFields.description).toBe(true);

    const second = upgradeStoredSettings(first.settings);
    expect(second.needsWrite).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });
});

/** `description` on, `features` off — the mixed row of a user who opted in early. */
const DEFAULT_ENABLED_FIELDS_DESCRIPTION_ON = {
  ...DEFAULT_AMAZON_SETTINGS.enabledFields,
  description: true,
  features: false,
};
