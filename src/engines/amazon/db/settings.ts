import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_AMAZON_SETTINGS,
  DEFAULT_ENABLED_FIELDS,
} from '../constants/defaults';
import { SettingsSchema } from '../schemas/settings';
import type { AppSettings, EnabledFieldsConfig } from '../types';
import { db } from './database';

let settingsWriteQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `op` after every queued settings write so reads that repair the row
 * (SAD-334's migration) can never interleave with a user update.
 */
function enqueueSettingsWrite<T>(op: () => Promise<T>): Promise<T> {
  const nextOp = settingsWriteQueue.then(op);
  settingsWriteQueue = nextOp.catch(() => {});
  return nextOp;
}

/**
 * The version a row is treated as when it carries no `settingsVersion` field,
 * i.e. when it was written before SAD-334 existed.
 */
const LEGACY_SETTINGS_VERSION = 0;

/**
 * Validates a raw settings record, merging `enabledFields` with defaults.
 * Returns `null` when the record is absent, not an object, or schema-invalid.
 */
function parseStoredSettings(raw: unknown): AppSettings | null {
  if (!raw || typeof raw !== 'object') {
    return null;
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
  return parsed.success ? parsed.data : null;
}

/**
 * Validates a raw settings record from IndexedDB, merging `enabledFields` with defaults.
 * Logs an error and degrades gracefully to schema defaults if the stored row is invalid.
 */
export function parseStoredSettingsSafe(raw: unknown): AppSettings {
  const parsed = parseStoredSettings(raw);
  if (parsed) {
    return parsed;
  }

  if (raw && typeof raw === 'object') {
    console.error(
      '[PPHunt] Stored settings are invalid; falling back to defaults',
    );
  }

  return SettingsSchema.parse({});
}

/**
 * SAD-334: one-time, user-reversible upgrade of rows written before
 * `description`/`features` defaulted to `true`.
 *
 * A row with no `settingsVersion` was written by an older build, so it is
 * treated as version 0 and upgraded exactly once: the marker is stamped, and
 * the two flags are flipped only when **both** were off — the fingerprint of
 * "never touched, old default". A row that already carries the marker is
 * returned untouched, so a deliberate toggle-off after the migration sticks.
 *
 * A missing or corrupt row degrades to defaults and is never rewritten.
 */
export function upgradeStoredSettings(raw: unknown): {
  settings: AppSettings;
  needsWrite: boolean;
} {
  const parsed = parseStoredSettings(raw);
  if (!parsed) {
    return { settings: parseStoredSettingsSafe(raw), needsWrite: false };
  }

  const rawVersion =
    raw && typeof raw === 'object'
      ? (raw as { settingsVersion?: unknown }).settingsVersion
      : undefined;
  const recordedVersion =
    typeof rawVersion === 'number' && Number.isFinite(rawVersion)
      ? rawVersion
      : LEGACY_SETTINGS_VERSION;

  if (recordedVersion >= CURRENT_SETTINGS_VERSION) {
    return { settings: parsed, needsWrite: false };
  }

  const bothWereOff =
    parsed.enabledFields.description === false &&
    parsed.enabledFields.features === false;

  return {
    settings: {
      ...parsed,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      ...(bothWereOff
        ? {
            enabledFields: {
              ...parsed.enabledFields,
              description: true,
              features: true,
            },
          }
        : {}),
    },
    needsWrite: true,
  };
}

/** Factory defaults, already stamped with the current schema version. */
function createDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_AMAZON_SETTINGS,
    id: 'default',
    settingsVersion: CURRENT_SETTINGS_VERSION,
    enabledFields: { ...DEFAULT_ENABLED_FIELDS },
  };
}

/**
 * Reads the current `AppSettings` from IndexedDB (`id = 'default'`), seeding defaults if absent
 * and degrading gracefully to defaults if malformed.
 *
 * SAD-334: a pre-migration row is upgraded here, inside the serialized write
 * queue. The row is re-read inside the queue so a concurrent user update is
 * never clobbered, and a second read is a pure no-op.
 */
export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get('default');
  if (!row) {
    const defaults = createDefaultSettings();
    try {
      await db.settings.put(defaults);
    } catch {
      // Ignore read-only/closed DB during teardown
    }
    return defaults;
  }

  const { settings, needsWrite } = upgradeStoredSettings(row);
  if (!needsWrite) {
    return settings;
  }

  return enqueueSettingsWrite(async () => {
    const latestRaw = await db.settings.get('default');
    if (!latestRaw) {
      // The row disappeared while we waited; do not resurrect it here.
      return settings;
    }

    const latest = upgradeStoredSettings(latestRaw);
    if (!latest.needsWrite) {
      // Someone (a user update or a parallel read) already migrated it.
      return latest.settings;
    }

    await db.settings.put(latest.settings);
    return latest.settings;
  });
}

export type SettingsUpdate = Partial<Omit<AppSettings, 'enabledFields'>> & {
  enabledFields?: Partial<EnabledFieldsConfig>;
};

/**
 * Deep-merges a partial settings update into the stored `default` row inside a serialized write queue
 * so rapid concurrent toggles never clobber sibling keys.
 *
 * SAD-334: an update on a pre-migration row upgrades it first and stamps the
 * current version, so every write path — not just the read path — leaves the
 * row migrated. An explicit user toggle wins over the migration default.
 */
export function updateSettings(
  partial: SettingsUpdate,
): Promise<AppSettings> {
  return enqueueSettingsWrite(async () => {
    const currentRaw = await db.settings.get('default');
    const current = currentRaw
      ? upgradeStoredSettings(currentRaw).settings
      : createDefaultSettings();

    const nextCandidate: AppSettings = {
      ...current,
      ...partial,
      id: 'default',
      settingsVersion: CURRENT_SETTINGS_VERSION,
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
}

/**
 * Resets the stored settings row back to clean factory defaults.
 */
export function resetSettings(): Promise<AppSettings> {
  return enqueueSettingsWrite(async () => {
    const defaults = createDefaultSettings();
    await db.settings.put(defaults);
    return defaults;
  });
}

export const restoreDefaultSettings = resetSettings;
