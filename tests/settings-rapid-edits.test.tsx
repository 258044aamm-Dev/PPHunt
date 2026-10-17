/**
 * Step 3.2 (SAD-168) — H-4: rapid settings edits must not be lost.
 *
 * Reproduced defect: two checkbox clicks under 500 ms apart persisted only
 * the second one; the first checkbox visibly reverted after the live-query
 * round trip. Root causes: last-write-wins debounce, stale full-object
 * snapshots from the render closure, and a shallow merge that bypassed the
 * deep-merging DB layer.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { db } from '@/lib/db/database';
import { SettingsSchema } from '@/lib/schemas/settings';
import { Header } from '@/entrypoints/sidepanel/components/Header';
import { SettingsOverlay } from '@/entrypoints/sidepanel/components/SettingsOverlay';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { useSettings } from '@/entrypoints/sidepanel/hooks/useSettings';

function renderSettings() {
  render(
    <StrictMode>
      <Header />
      <SettingsOverlay />
    </StrictMode>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
}

describe('H-4: rapid settings edits (real SettingsOverlay)', () => {
  beforeEach(async () => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    await db.delete();
    await db.open();
    useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('the reproducing case: two checkbox clicks under one debounce window BOTH persist', async () => {
    renderSettings();
    await screen.findByText('GENERAL', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('Title'));
    fireEvent.click(screen.getByLabelText('ASIN')); // < 500 ms after the first

    await waitFor(
      async () => {
        const row = await db.settings.get('default');
        expect(row?.enabledFields).toMatchObject({
          title: false, // was LOST before SAD-168 (persisted true)
          asin: false,
        });
      },
      { timeout: 3000 }
    );
  });

  it('5 rapid distinct toggles all persist; untouched fields keep their values', async () => {
    renderSettings();
    await screen.findByText('GENERAL', {}, { timeout: 3000 });

    const toggled = ['Title', 'ASIN', 'URL', 'Price', 'Rating'];
    for (const label of toggled) {
      fireEvent.click(screen.getByLabelText(label));
    }

    await waitFor(
      async () => {
        const row = await db.settings.get('default');
        expect(row?.enabledFields).toMatchObject({
          title: false,
          asin: false,
          url: false,
          price: false,
          rating: false,
          // untouched fields keep their defaults
          listPrice: true,
          currency: true,
          reviewCount: true,
        });
      },
      { timeout: 3000 }
    );
  });
});

describe('H-4: rapid settings edits (useSettings hook, injected debounce)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
  });

  async function setupHook() {
    const view = renderHook(() => useSettings({ saveDebounceMs: 5 }));
    await waitFor(() => expect(view.result.current.settings).not.toBeNull());
    return view;
  }

  it('mixed keys in one burst all persist (full enabledFields snapshot + scalars)', async () => {
    const { result } = await setupHook();
    const row0 = result.current.settings!;

    act(() => {
      // what the overlay actually sends per interaction:
      result.current.updateSettings({
        enabledFields: { ...row0.enabledFields, title: false }, // full snapshot
      });
      result.current.updateSettings({ defaultMode: 'automatic' });
      result.current.updateSettings({ scrollInterval: 2000 });
    });

    await waitFor(async () => {
      const row = await db.settings.get('default');
      expect(row).toMatchObject({
        defaultMode: 'automatic',
        scrollInterval: 2000,
      });
      expect(row?.enabledFields).toMatchObject({
        title: false,
        asin: true, // untouched by any partial — must survive
      });
    });
  });

  it('stale full-object snapshots cannot resurrect values changed earlier in the window', async () => {
    const { result } = await setupHook();
    const row0 = result.current.settings!;

    act(() => {
      // Both snapshots are built from the SAME stale row0 — the second one
      // still carries title: true, exactly like two fast checkbox clicks.
      result.current.updateSettings({
        enabledFields: { ...row0.enabledFields, title: false },
      });
      result.current.updateSettings({
        enabledFields: { ...row0.enabledFields, asin: false },
      });
    });

    await waitFor(async () => {
      const row = await db.settings.get('default');
      expect(row?.enabledFields).toMatchObject({ title: false, asin: false });
    });
  });

  it('slider drag: 10 rapid scrollInterval changes persist the final value only', async () => {
    const { result } = await setupHook();

    act(() => {
      for (let v = 200; v <= 1100; v += 100) {
        result.current.updateSettings({ scrollInterval: v });
      }
    });

    await waitFor(async () => {
      const row = await db.settings.get('default');
      expect(row?.scrollInterval).toBe(1100);
      // other keys uncorrupted by the burst
      expect(row).toMatchObject({
        scrollSpeed: SettingsSchema.parse({}).scrollSpeed,
        waitAfterScroll: SettingsSchema.parse({}).waitAfterScroll,
        defaultTargetCount: SettingsSchema.parse({}).defaultTargetCount,
      });
    });
  });

  it('restoreDefaults drops queued partials instead of being clobbered by them', async () => {
    const { result } = await setupHook();

    act(() => {
      result.current.updateSettings({ defaultTargetCount: 999 });
    });
    await act(async () => {
      await result.current.restoreDefaults();
    });

    // wait past the (cancelled) debounce window
    await new Promise((r) => setTimeout(r, 30));
    const row = await db.settings.get('default');
    expect(row?.defaultTargetCount).toBe(SettingsSchema.parse({}).defaultTargetCount);
  });
});
