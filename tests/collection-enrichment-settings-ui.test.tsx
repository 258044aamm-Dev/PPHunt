/**
 * SAD-379 step 2 / SAD-385 — the COLLECTION ENRICHMENT section in the Amazon
 * settings.
 *
 * Drives the real `AmazonSettingsOverlay` (no re-implementation). What matters
 * here is the contract the service worker depends on: the per-run budget is
 * persisted in the settings row, mirrored into `storage.local` where the worker
 * reads it synchronously, defaults to `all` on a fresh install, and is restored
 * to `all` by Restore Defaults — which cannot reach the mirror on its own.
 *
 * SAD-385 removed the on/off switch: a collection always enriches, because
 * `weight` and the full `variations` exist only on the product page. The first
 * test below pins that removal, so a stray checkbox cannot come back and make
 * the reported bug reachable again.
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
  getEnrichCollectedLimit,
  resetEnrichCollectedForTests,
} from '@/engines/amazon/utils/enrich-collected-flag';

let storageState: Record<string, unknown>;

function getRadio(name: RegExp) {
  return screen.getByRole('radio', { name }) as HTMLInputElement;
}

/**
 * The settings row is written through a 500 ms debounce (SAD-276 behaviour), so
 * every assertion on the *persisted* value has to wait rather than read once.
 */
async function expectStoredLimit(limit: string) {
  await waitFor(
    async () => {
      const row = await getSettings();
      expect(row.enrichCollectedLimit).toBe(limit);
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

describe('SAD-385 collection enrichment settings', () => {
  it('offers no on/off switch at all', async () => {
    await renderOverlay();

    expect(
      screen.queryByRole('checkbox', { name: /Enrich collected products/ }),
    ).toBeNull();
  });

  it('defaults to every collected product, with every limit selectable', async () => {
    await renderOverlay();

    expect(getRadio(/Every collected product/).checked).toBe(true);
    expect(getRadio(/25 products per run/).disabled).toBe(false);
    expect(getRadio(/50 products per run/).disabled).toBe(false);
    expect(getRadio(/Every collected product/).disabled).toBe(false);
    // Nothing mirrored until the user chooses something.
    expect(storageState[ENRICH_COLLECTED_KEY]).toBeUndefined();
  });

  it('choosing a cap writes it to both copies', async () => {
    await renderOverlay();

    fireEvent.click(getRadio(/25 products per run/));

    await waitFor(() =>
      expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({ limit: '25' }),
    );
    expect(getEnrichCollectedLimit()).toBe(25);
    await expectStoredLimit('25');
  });

  it('"Every collected product" reaches the worker as an unbounded limit', async () => {
    await renderOverlay();
    fireEvent.click(getRadio(/25 products per run/));
    // The radio's `checked` follows the settings row, so wait for the render to
    // catch up before clicking a *different* radio — a click on a radio the DOM
    // already shows as selected fires no change event (real browser behaviour,
    // and why this wait is not cosmetic).
    await waitFor(() => expect(getRadio(/25 products per run/).checked).toBe(true));

    fireEvent.click(getRadio(/Every collected product/));

    await waitFor(() =>
      expect(getEnrichCollectedLimit()).toBe(Number.POSITIVE_INFINITY),
    );
    expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({ limit: 'all' });
  });

  it('a saved choice survives a remount', async () => {
    await renderOverlay();
    fireEvent.click(getRadio(/50 products per run/));
    await waitFor(() => expect(getRadio(/50 products per run/).checked).toBe(true));

    cleanup();
    await renderOverlay();

    await waitFor(() => expect(getRadio(/50 products per run/).checked).toBe(true));
    expect(getRadio(/Every collected product/).checked).toBe(false);
  });

  it('Restore Defaults resets the settings row *and* the storage.local mirror', async () => {
    await renderOverlay();
    fireEvent.click(getRadio(/25 products per run/));
    await waitFor(() =>
      expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({ limit: '25' }),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Restore Default Settings' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(storageState[ENRICH_COLLECTED_KEY]).toEqual({ limit: 'all' }),
    );
    expect(getEnrichCollectedLimit()).toBe(Number.POSITIVE_INFINITY);
    await expectStoredLimit('all');
  });
});
