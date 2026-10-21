/**
 * SAD-379 step 2 — the COLLECTION ENRICHMENT section in the Amazon settings.
 *
 * Drives the real `AmazonSettingsOverlay` (no re-implementation). What matters
 * here is the contract the service worker depends on: the switch is persisted in
 * the settings row, mirrored into `storage.local` where the worker reads it
 * synchronously, off on a fresh install, and restored to off/50 by Restore
 * Defaults — which cannot reach the mirror on its own.
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
import { getSettings } from '@/engines/amazon/db/settings';
import {
  ENRICH_COLLECTED_KEY,
  getEnrichCollectedSettings,
  resetEnrichCollectedForTests,
} from '@/engines/amazon/utils/enrich-collected-flag';

let storageState: Record<string, unknown>;

function getSwitch() {
  return screen.getByRole('checkbox', {
    name: /Enrich collected products/,
  }) as HTMLInputElement;
}

function getRadio(name: RegExp) {
  return screen.getByRole('radio', { name }) as HTMLInputElement;
}

/**
 * The settings row is written through a 500 ms debounce (SAD-276 behaviour), so
 * every assertion on the *persisted* value has to wait rather than read once.
 */
async function expectStored(
  expected: { enabled: boolean; limit: string },
) {
  await waitFor(
    async () => {
      const row = await getSettings();
      expect(row.enrichCollectedProducts).toBe(expected.enabled);
      expect(row.enrichCollectedLimit).toBe(expected.limit);
    },
    { timeout: 3000 },
  );
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
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  resetEnrichCollectedForTests();
  await db.delete();
  await db.open();
  useAmazonUIStore.setState({ settingsOpen: true });
});

afterEach(async () => {
  cleanup();
  await db.delete();
  resetEnrichCollectedForTests();
  vi.unstubAllGlobals();
});

async function renderOverlay() {
  render(
    <StrictMode>
      <AmazonSettingsOverlay />
    </StrictMode>,
  );
  await screen.findByText('COLLECTION ENRICHMENT', {}, { timeout: 3000 });
}

describe('SAD-379 collection enrichment settings', () => {
  it('is off by default, with the limit radios unavailable', async () => {
    await renderOverlay();

    expect(getSwitch().checked).toBe(false);
    expect(getRadio(/25 products per run/).disabled).toBe(true);
    expect(getRadio(/50 products per run/).disabled).toBe(true);
    expect(getRadio(/Every collected product/).disabled).toBe(true);
    // Nothing mirrored until the user chooses something.
    expect(storageState[ENRICH_COLLECTED_KEY]).toBeUndefined();
  });

  it('turning it on persists both copies and unblocks the limit radios', async () => {
    await renderOverlay();

    fireEvent.click(getSwitch());

    await waitFor(() => expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({
      enabled: true,
      limit: '50',
    }));
    await waitFor(() => expect(getSwitch().checked).toBe(true));
    expect(getEnrichCollectedSettings()).toEqual({ enabled: true, limit: 50 });
    await expectStored({ enabled: true, limit: '50' });
  });

  it('choosing a cap writes it to both copies', async () => {
    await renderOverlay();
    fireEvent.click(getSwitch());
    await waitFor(() => expect(getRadio(/25 products per run/).disabled).toBe(false));

    fireEvent.click(getRadio(/25 products per run/));

    await waitFor(() =>
      expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({
        enabled: true,
        limit: '25',
      }),
    );
    expect(getEnrichCollectedSettings()).toEqual({ enabled: true, limit: 25 });
    await expectStored({ enabled: true, limit: '25' });
  });

  it('"Every collected product" reaches the worker as an unbounded limit', async () => {
    await renderOverlay();
    fireEvent.click(getSwitch());
    await waitFor(() => expect(getRadio(/Every collected product/).disabled).toBe(false));

    fireEvent.click(getRadio(/Every collected product/));

    await waitFor(() =>
      expect(getEnrichCollectedSettings().limit).toBe(
        Number.POSITIVE_INFINITY,
      ),
    );
  });

  it('a saved choice survives a remount', async () => {
    await renderOverlay();
    fireEvent.click(getSwitch());
    await waitFor(() => expect(getSwitch().checked).toBe(true));
    fireEvent.click(getRadio(/25 products per run/));
    await waitFor(() => expect((getRadio(/25 products per run/) as HTMLInputElement).checked).toBe(true));

    cleanup();
    await renderOverlay();

    await waitFor(() => expect(getSwitch().checked).toBe(true));
    expect(getRadio(/25 products per run/).checked).toBe(true);
  });

  it('Restore Defaults resets the settings row *and* the storage.local mirror', async () => {
    await renderOverlay();
    fireEvent.click(getSwitch());
    await waitFor(() => expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({
      enabled: true,
      limit: '50',
    }));

    fireEvent.click(
      screen.getByRole('button', { name: 'Restore Default Settings' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({
      enabled: false,
      limit: '50',
    }));
    await waitFor(() => expect(getSwitch().checked).toBe(false));
    expect(getEnrichCollectedSettings()).toEqual({ enabled: false, limit: 50 });
    await expectStored({ enabled: false, limit: '50' });
  });
});


it('explains that missing brand/rank fallback is independent of the full-detail switch and cap', async () => {
  await renderOverlay();
  expect(await screen.findByText(/are always fetched, independently of this switch and limit/)).toBeTruthy();
});
