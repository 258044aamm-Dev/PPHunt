/**
 * SAD-369 step 1 — the diagnostics on/off switch itself.
 *
 * The switch is the gate every log site checks, so its contract is tested
 * directly: default off, literal-true-only reads (fail closed on junk),
 * write-through, and live storage updates with a working disposer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DIAGNOSTICS_ENABLED,
  DIAGNOSTICS_ENABLED_KEY,
  readDiagnosticsEnabled,
} from '@/engines/amazon/constants/diagnostics';
import {
  getDiagnosticsEnabled,
  refreshDiagnosticsEnabled,
  setDiagnosticsEnabled,
  subscribeDiagnosticsEnabled,
} from '@/engines/amazon/utils/diagnostics-flag';

type ChangeListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

function makeFakeStorage(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const listenerRef: { current: ChangeListener | null } = { current: null };
  const fakeBrowser = {
    storage: {
      local: {
        // The accessor calls `get(key)` with a single string key.
        get: vi.fn(async (key: string) => {
          return store.has(key) ? { [key]: store.get(key) } : {};
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            store.set(key, value);
          }
        }),
        remove: vi.fn(async () => undefined),
      },
      onChanged: {
        addListener: vi.fn((fn: ChangeListener) => {
          listenerRef.current = fn;
        }),
        removeListener: vi.fn(),
      },
    },
  };
  return { fakeBrowser, store, listenerRef };
}

afterEach(async () => {
  // Reset the module-level cache to the production default so tests never
  // leak switch state into each other. Cache-only write: `{}` has no storage.
  await setDiagnosticsEnabled(false, {});
});

describe('SAD-369 diagnostics switch', () => {
  it('is off by default and reads only a literal true', () => {
    expect(DIAGNOSTICS_ENABLED_KEY).toBe('pphuntDiagnosticsEnabled');
    expect(DEFAULT_DIAGNOSTICS_ENABLED).toBe(false);
    expect(readDiagnosticsEnabled(undefined)).toBe(false);
    expect(readDiagnosticsEnabled(true)).toBe(true);
    // Fail closed on anything that is not the literal boolean:
    expect(readDiagnosticsEnabled('true')).toBe(false);
    expect(readDiagnosticsEnabled(1)).toBe(false);
    expect(readDiagnosticsEnabled(false)).toBe(false);
  });

  it('stays off after refresh when storage is empty or absent', async () => {
    await refreshDiagnosticsEnabled(makeFakeStorage().fakeBrowser);
    expect(getDiagnosticsEnabled()).toBe(false);

    // No storage.local at all (e.g. non-extension context): refresh is a
    // no-op and the cached value survives.
    await setDiagnosticsEnabled(true, {});
    await refreshDiagnosticsEnabled({});
    expect(getDiagnosticsEnabled()).toBe(true);
    await setDiagnosticsEnabled(false, {});
  });

  it('fails closed when storage returns junk or throws', async () => {
    const junk = makeFakeStorage({ [DIAGNOSTICS_ENABLED_KEY]: 'true' });
    await refreshDiagnosticsEnabled(junk.fakeBrowser);
    expect(getDiagnosticsEnabled()).toBe(false);

    const broken = {
      storage: {
        local: {
          get: vi.fn(async () => {
            throw new Error('storage is gone');
          }),
          set: vi.fn(),
          remove: vi.fn(),
        },
      },
    };
    await refreshDiagnosticsEnabled(broken);
    expect(getDiagnosticsEnabled()).toBe(false);
  });

  it('writes through to storage and reads the value back', async () => {
    const { fakeBrowser, store } = makeFakeStorage();

    await setDiagnosticsEnabled(true, fakeBrowser);
    expect(getDiagnosticsEnabled()).toBe(true);
    expect(store.get(DIAGNOSTICS_ENABLED_KEY)).toBe(true);

    // A fresh module cache (simulated by refreshing from storage) agrees.
    await refreshDiagnosticsEnabled(fakeBrowser);
    expect(getDiagnosticsEnabled()).toBe(true);

    await setDiagnosticsEnabled(false, fakeBrowser);
    expect(store.get(DIAGNOSTICS_ENABLED_KEY)).toBe(false);
    await refreshDiagnosticsEnabled(fakeBrowser);
    expect(getDiagnosticsEnabled()).toBe(false);
  });

  it('tracks live storage changes until the disposer runs', async () => {
    const { fakeBrowser, listenerRef } = makeFakeStorage();
    const dispose = subscribeDiagnosticsEnabled(fakeBrowser);
    expect(listenerRef.current).not.toBeNull();

    listenerRef.current!(
      { [DIAGNOSTICS_ENABLED_KEY]: { newValue: true } },
      'local',
    );
    expect(getDiagnosticsEnabled()).toBe(true);

    // Unrelated areas and keys must not touch the cache.
    listenerRef.current!(
      { [DIAGNOSTICS_ENABLED_KEY]: { newValue: false } },
      'sync',
    );
    expect(getDiagnosticsEnabled()).toBe(true);
    listenerRef.current!({ someOtherKey: { newValue: false } }, 'local');
    expect(getDiagnosticsEnabled()).toBe(true);

    listenerRef.current!(
      { [DIAGNOSTICS_ENABLED_KEY]: { newValue: false } },
      'local',
    );
    expect(getDiagnosticsEnabled()).toBe(false);

    dispose();
    expect(fakeBrowser.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);

    // The disposer releases the module-level guard: a second subscription
    // (e.g. a content-script remount) attaches a fresh listener.
    const disposeAgain = subscribeDiagnosticsEnabled(fakeBrowser);
    expect(fakeBrowser.storage.onChanged.addListener).toHaveBeenCalledTimes(2);
    disposeAgain();
  });
});
