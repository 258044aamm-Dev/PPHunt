/**
 * SAD-369 step 1 — the DIAGNOSTICS section in the Amazon engine settings.
 *
 * The switch lives in storage.local (not the settings row) so the content
 * script can read it. These tests drive the real overlay: fresh install shows
 * it off, toggling writes through and updates the cached accessor, a saved
 * "on" survives a remount, and Restore Defaults resets it to off.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { AmazonSettingsOverlay } from '@/engines/amazon/ui/components/SettingsOverlay';
import { useAmazonUIStore } from '@/engines/amazon/ui/store/uiStore';
import { db } from '@/engines/amazon/db/database';
import { DIAGNOSTICS_ENABLED_KEY } from '@/engines/amazon/constants/diagnostics';
import {
  getDiagnosticsEnabled,
  setDiagnosticsEnabled,
} from '@/engines/amazon/utils/diagnostics-flag';

let storageState: Record<string, unknown>;

function getCheckbox() {
  return screen.getByRole('checkbox', {
    name: /Enable extraction diagnostics/,
  }) as HTMLInputElement;
}

beforeEach(async () => {
  storageState = {};
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...storageState })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(storageState, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete storageState[key];
        }),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
  // Start every test from the production default (off), cache-only.
  await setDiagnosticsEnabled(false, {});
  await db.delete();
  await db.open();
  useAmazonUIStore.setState({ settingsOpen: true });
});

afterEach(async () => {
  cleanup();
  await db.delete();
  await setDiagnosticsEnabled(false, {});
  vi.unstubAllGlobals();
});

async function renderOverlay() {
  render(
    <StrictMode>
      <AmazonSettingsOverlay />
    </StrictMode>,
  );
  await screen.findByText('DIAGNOSTICS', {}, { timeout: 3000 });
}

describe('SAD-369 diagnostics setting UI', () => {
  it('shows the DIAGNOSTICS switch off on a fresh install', async () => {
    await renderOverlay();
    expect(getCheckbox().checked).toBe(false);
    expect(storageState[DIAGNOSTICS_ENABLED_KEY]).toBeUndefined();
  });

  it('persists the switch to storage.local and updates the cached flag', async () => {
    await renderOverlay();

    fireEvent.click(getCheckbox());
    await waitFor(() => {
      expect(storageState[DIAGNOSTICS_ENABLED_KEY]).toBe(true);
    });
    expect(getCheckbox().checked).toBe(true);
    expect(getDiagnosticsEnabled()).toBe(true);

    fireEvent.click(getCheckbox());
    await waitFor(() => {
      expect(storageState[DIAGNOSTICS_ENABLED_KEY]).toBe(false);
    });
    expect(getCheckbox().checked).toBe(false);
    expect(getDiagnosticsEnabled()).toBe(false);
  });

  it('restores a saved "on" state when the overlay remounts', async () => {
    storageState[DIAGNOSTICS_ENABLED_KEY] = true;

    await renderOverlay();
    await waitFor(() => expect(getCheckbox().checked).toBe(true));
    expect(getDiagnosticsEnabled()).toBe(true);
  });

  it('Restore Defaults resets the switch to off', async () => {
    storageState[DIAGNOSTICS_ENABLED_KEY] = true;
    await renderOverlay();
    await waitFor(() => expect(getCheckbox().checked).toBe(true));

    fireEvent.click(
      screen.getByRole('button', { name: 'Restore Default Settings' }),
    );
    // The shared confirm dialog gates the destructive reset.
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(storageState[DIAGNOSTICS_ENABLED_KEY]).toBe(false);
      expect(getCheckbox().checked).toBe(false);
    });
    expect(getDiagnosticsEnabled()).toBe(false);
  });
});
