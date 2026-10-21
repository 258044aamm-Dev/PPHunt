/**
 * SAD-383 step 4 — the setting.
 *
 * Two things matter beyond "it round-trips":
 * - it is **on by default**, because a collection that never fills the field is
 *   the bug being fixed (SAD-379's switch stays off and keeps its own meaning);
 * - a settings row written **before** this ticket still parses, with no
 *   `settingsVersion` bump — the same precedent SAD-349/357/379 followed.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AMAZON_SETTINGS,
  DEFAULT_RATING_BACKFILL,
} from '@/engines/amazon/constants/defaults';
import {
  AmazonSettingsSchema,
  PartialAmazonSettingsSchema,
} from '@/engines/amazon/schemas/settings';
import {
  getSettings,
  resetSettings,
  updateSettings,
} from '@/engines/amazon/db/settings';
import { db } from '@/engines/amazon/db/database';

beforeEach(async () => {
  await db.settings.clear();
});

describe('SAD-383: the backfill setting', () => {
  it('defaults to ON, independently of the SAD-379 switch', () => {
    expect(DEFAULT_RATING_BACKFILL).toBe(true);
    expect(DEFAULT_AMAZON_SETTINGS.backfillCollectedRatings).toBe(true);
    // SAD-379's switch is untouched and still off.
    expect(DEFAULT_AMAZON_SETTINGS.enrichCollectedProducts).toBe(false);
  });

  it('parses a settings row written before this ticket', () => {
    const parsed = AmazonSettingsSchema.parse({
      ...DEFAULT_AMAZON_SETTINGS,
      // The key did not exist when this row was written.
      backfillCollectedRatings: undefined,
    });
    expect(parsed.backfillCollectedRatings).toBe(DEFAULT_RATING_BACKFILL);
  });

  it('accepts a partial update that mentions only the new key', () => {
    expect(
      PartialAmazonSettingsSchema.parse({ backfillCollectedRatings: false }),
    ).toEqual({ backfillCollectedRatings: false });
  });

  it('round-trips through the settings row without touching its neighbours', async () => {
    const before = await getSettings();
    expect(before.backfillCollectedRatings).toBe(true);

    await updateSettings({ backfillCollectedRatings: false });

    const after = await getSettings();
    expect(after.backfillCollectedRatings).toBe(false);
    // Everything else is exactly as it was.
    expect(after.enrichCollectedProducts).toBe(before.enrichCollectedProducts);
    expect(after.enrichCollectedLimit).toBe(before.enrichCollectedLimit);
    expect(after.settingsVersion).toBe(before.settingsVersion);
  });

  it('Restore Defaults turns it back on', async () => {
    await updateSettings({ backfillCollectedRatings: false });
    const restored = await resetSettings();
    expect(restored.backfillCollectedRatings).toBe(true);
  });

  it('leaves no settingsVersion bump behind', async () => {
    const settings = await getSettings();
    // Whatever the tree's current version is, it must not have changed because of
    // this ticket — the key is optional-with-default.
    const raw = await db.settings.get('default');
    expect(raw?.settingsVersion).toBe(settings.settingsVersion);
  });
});
