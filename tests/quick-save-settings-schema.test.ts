/**
 * SAD-276 (P0.3) - "Right-Click Save Behavior" and the auto-download flag are
 * persisted end to end, and an existing settings row written before these keys
 * existed keeps working untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_QUICK_SAVE_AUTO_DOWNLOAD,
  DEFAULT_QUICK_SAVE_COLLECTION_BEHAVIOR,
  DEFAULT_AMAZON_SETTINGS,
} from '@/engines/amazon/constants/defaults';
import { db } from '@/lib/db/database';
import { getSettings, updateSettings } from '@/lib/db/settings';
import {
  AmazonSettingsSchema,
  PartialAmazonSettingsSchema,
} from '@/engines/amazon/schemas/settings';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('quick-save settings', () => {
  it('defaults to "Add to Current Collection" with auto-download off', async () => {
    const settings = await getSettings();

    expect(settings.quickSaveCollectionBehavior).toBe('current');
    expect(settings.quickSaveCollectionBehavior).toBe(
      DEFAULT_QUICK_SAVE_COLLECTION_BEHAVIOR
    );
    expect(settings.quickSaveAutoDownload).toBe(DEFAULT_QUICK_SAVE_AUTO_DOWNLOAD);
    expect(settings.quickSaveAutoDownload).toBe(false);
  });

  it('the factory defaults object carries the new keys', () => {
    expect(DEFAULT_AMAZON_SETTINGS.quickSaveCollectionBehavior).toBe('current');
    expect(DEFAULT_AMAZON_SETTINGS.quickSaveAutoDownload).toBe(false);
  });

  it('a settings row written before these keys existed still parses', async () => {
    // Exactly the shape a v1 install holds: no quick-save keys at all.
    await db.settings.put({
      ...DEFAULT_AMAZON_SETTINGS,
      exportFormat: 'excel',
      notifications: false,
    } as never);
    const legacy = await db.settings.get('default');
    if (legacy) {
      delete (legacy as unknown as Record<string, unknown>)
        .quickSaveCollectionBehavior;
      delete (legacy as unknown as Record<string, unknown>).quickSaveAutoDownload;
      await db.settings.put(legacy);
    }

    const settings = await getSettings();

    expect(settings.quickSaveCollectionBehavior).toBe('current');
    expect(settings.quickSaveAutoDownload).toBe(false);
    // Pre-existing values survive the read.
    expect(settings.exportFormat).toBe('excel');
    expect(settings.notifications).toBe(false);
  });

  it('round-trips each behaviour through updateSettings without touching siblings', async () => {
    const before = await getSettings();

    for (const behaviour of ['new', 'ask', 'current'] as const) {
      const saved = await updateSettings({ quickSaveCollectionBehavior: behaviour });
      expect(saved.quickSaveCollectionBehavior).toBe(behaviour);

      const reread = await getSettings();
      expect(reread.quickSaveCollectionBehavior).toBe(behaviour);
      expect(reread.defaultTargetCount).toBe(before.defaultTargetCount);
      expect(reread.exportFormat).toBe(before.exportFormat);
      expect(reread.enabledFields).toEqual(before.enabledFields);
    }
  });

  it('round-trips the auto-download flag', async () => {
    await updateSettings({ quickSaveAutoDownload: true });
    expect((await getSettings()).quickSaveAutoDownload).toBe(true);

    await updateSettings({ quickSaveAutoDownload: false });
    expect((await getSettings()).quickSaveAutoDownload).toBe(false);
  });

  it('rejects an unknown behaviour at the schema boundary', () => {
    expect(AmazonSettingsSchema.safeParse({ quickSaveCollectionBehavior: 'sometimes' }).success).toBe(
      false
    );
    expect(PartialAmazonSettingsSchema.safeParse({ quickSaveCollectionBehavior: 'ask' }).success).toBe(
      true
    );
    expect(
      PartialAmazonSettingsSchema.safeParse({ quickSaveCollectionBehavior: 'sometimes' }).success
    ).toBe(false);
  });

  it('a corrupted stored behaviour degrades to a valid settings object instead of throwing', async () => {
    await db.settings.put({
      ...DEFAULT_AMAZON_SETTINGS,
      quickSaveCollectionBehavior: 'sometimes',
    } as never);

    const settings = await getSettings();

    expect(['current', 'new', 'ask']).toContain(settings.quickSaveCollectionBehavior);
    // Existing degradation contract: an invalid row falls back to defaults.
    expect(settings).toEqual(AmazonSettingsSchema.parse({}));
  });
});
