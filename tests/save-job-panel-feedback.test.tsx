/**
 * SAD-343 — the side panel now renders feedback for a one-click save.
 *
 * Before this, `SAVE_JOB_UPDATE` was broadcast by the background and ignored by
 * the panel, so a save performed while the panel was open produced nothing
 * visible. These tests pin the surface: one toast per completed save, the
 * enrichment warning folded into that same toast, the existing `notifications`
 * gate, and a listener that is removed on unmount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { db } from '@/lib/db/database';
import { SettingsSchema } from '@/lib/schemas/settings';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useToastStore } from '@/entrypoints/sidepanel/components/ToastContainer';
import type { AppSettings } from '@/types/settings';

type OnMessageListener = (msg: unknown, sender?: unknown) => unknown;

let listeners: OnMessageListener[] = [];
let removeListener: ReturnType<typeof vi.fn>;

function stubBrowser(tabUrl = 'https://www.amazon.com/s?k=charger') {
  listeners = [];
  removeListener = vi.fn((fn: OnMessageListener) => {
    listeners = listeners.filter((current) => current !== fn);
  });

  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: OnMessageListener) => {
          listeners.push(fn);
        },
        removeListener,
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([{ id: 7, windowId: 1, active: true, url: tabUrl }]),
      get: vi.fn().mockResolvedValue({ id: 7, url: tabUrl }),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setPopup: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      onClicked: { addListener: vi.fn() },
    },
  });
}

/** Seeds settings, renders the panel, and waits until the row was consumed. */
async function renderPanel(
  overrides: Partial<AppSettings> = {},
  tabUrl?: string,
) {
  await db.settings.put({
    ...SettingsSchema.parse({ defaultTargetCount: 321 }),
    ...overrides,
  } as unknown as AppSettings);

  stubBrowser(tabUrl);
  const { default: App } = await import('@/entrypoints/sidepanel/App');
  render(<App />);

  await waitFor(() =>
    expect(useCollectionStore.getState().targetCount).toBe(321),
  );
}

function dispatch(message: unknown) {
  for (const listener of listeners) listener(message);
}

function saveUpdate(payload: Record<string, unknown>) {
  return { type: 'SAVE_JOB_UPDATE', payload };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  useCollectionStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SAD-343: panel feedback for a quick save', () => {
  it('shows one success toast for a completed save', async () => {
    await renderPanel();

    dispatch(
      saveUpdate({
        jobId: 'job-1',
        asin: 'B08N5WRWNW',
        state: 'completed',
        collectionLabel: 'Anker 65W Charger',
        productTitle: 'Anker 65W Charger',
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const [toast] = useToastStore.getState().toasts;
    expect(toast?.type).toBe('success');
    expect(toast?.message).toBe('Saved to History');
    expect(toast?.detail).toBe('Anker 65W Charger');
  });

  it('renders the enrichment warning in the same toast, not one on top of another', async () => {
    await renderPanel();

    dispatch(
      saveUpdate({
        jobId: 'job-warn',
        asin: 'B08N5WRWNW',
        state: 'completed',
        productTitle: 'Anker 65W Charger',
        warning:
          'Saved, but the product details could not be fetched — details may be incomplete',
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const [toast] = useToastStore.getState().toasts;
    expect(toast?.type).toBe('attention');
    expect(toast?.detail).toBe(
      'Saved, but the product details could not be fetched — details may be incomplete',
    );
  });

  it('ignores every non-terminal state', async () => {
    await renderPanel();

    for (const state of ['queued', 'extracting', 'enriching', 'failed']) {
      dispatch(
        saveUpdate({
          jobId: `job-${state}`,
          asin: 'B08N5WRWNW',
          state,
          updatedAt: '2026-10-19T00:00:01.000Z',
        }),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('respects notifications:false like every other in-panel toast', async () => {
    await renderPanel({ notifications: false });

    dispatch(
      saveUpdate({
        jobId: 'job-muted',
        asin: 'B08N5WRWNW',
        state: 'completed',
        productTitle: 'Anker 65W Charger',
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('announces a job id once, even if the update is replayed', async () => {
    await renderPanel();

    const update = saveUpdate({
      jobId: 'job-dupe',
      asin: 'B08N5WRWNW',
      state: 'completed',
      productTitle: 'Anker 65W Charger',
      updatedAt: '2026-10-19T00:00:01.000Z',
    });

    dispatch(update);
    dispatch(update);
    dispatch(update);

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
  });

  it('does not fire while the panel is showing the other marketplace engine', async () => {
    // A Temu tab: the panel's History is Temu's, so an Amazon save there would
    // be misleading.
    await renderPanel({}, 'https://www.temu.com/search?q=charger');

    await waitFor(() =>
      expect(useCollectionStore.getState().targetCount).toBe(321),
    );
    // Prove the engine really switched before dispatching; otherwise this test
    // would pass even without the Amazon-only gate.
    await waitFor(() =>
      expect(
        screen.getByTestId('engine-toggle-temu').getAttribute('aria-pressed'),
      ).toBe('true'),
    );

    dispatch(
      saveUpdate({
        jobId: 'job-temu-view',
        asin: 'B08N5WRWNW',
        state: 'completed',
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('stays quiet when the saving tab is the active tab (the page toast is on screen)', async () => {
    // The stub reports tab 7 as the active tab: this save came from it.
    await renderPanel();

    dispatch(
      saveUpdate({
        jobId: 'job-same-tab',
        asin: 'B08N5WRWNW',
        state: 'completed',
        productTitle: 'Anker 65W Charger',
        tabId: 7,
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('speaks up when the save came from another tab', async () => {
    await renderPanel();

    dispatch(
      saveUpdate({
        jobId: 'job-other-tab',
        asin: 'B08N5WRWNW',
        state: 'completed',
        productTitle: 'Anker 65W Charger',
        tabId: 99,
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]?.message).toBe('Saved to History');
  });

  it('still reports a warning when it came from another tab', async () => {
    await renderPanel();

    dispatch(
      saveUpdate({
        jobId: 'job-other-tab-warn',
        asin: 'B08N5WRWNW',
        state: 'completed',
        warning: 'Saved, but the product page was not fetched — details may be incomplete',
        tabId: 99,
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]?.type).toBe('attention');
  });

  it('treats a message with no tabId as "not visible" and shows the toast', async () => {
    await renderPanel();

    dispatch(
      saveUpdate({
        jobId: 'job-no-tab',
        asin: 'B08N5WRWNW',
        state: 'completed',
        productTitle: 'Anker 65W Charger',
        updatedAt: '2026-10-19T00:00:01.000Z',
      }),
    );

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
  });

  it('removes its listener on unmount', async () => {
    await renderPanel();
    cleanup();
    expect(removeListener).toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });
});
