/**
 * Step 4.3 (SAD-174) — H-5b: recovery selects the chronologically most
 * recent session (not the lexicographically-lowest key), and
 * pruneOldSessions() keeps the sessions table bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/database';
import { pruneOldSessions } from '@/lib/db/sessions';
import { useActiveBrowserTab } from '@/entrypoints/sidepanel/hooks/useActiveBrowserTab';
import { useSessionRecovery } from '@/entrypoints/sidepanel/hooks/useSessionRecovery';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useToastStore } from '@/entrypoints/sidepanel/components/ToastContainer';
import type { SessionState } from '@/types/session';

type OnMessageListener = (msg: unknown, sender?: unknown) => unknown;

function TrackerWithRecovery() {
  useActiveBrowserTab();
  const { notice } = useSessionRecovery();
  return notice ? <div>{notice.message}</div> : null;
}

function sessionRow(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    tabId: 0,
    url: 'https://www.amazon.com/s?k=x',
    status: 'collecting',
    mode: 'manual',
    targetCount: 50,
    collectedCount: 0,
    startedAt: new Date().toISOString(),
    ...partial,
  } as SessionState;
}

function stubBrowserForApp(listeners: OnMessageListener[]) {
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: OnMessageListener) => listeners.push(fn),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([
        { id: 7, windowId: 1, active: true, url: 'https://example.com/' },
      ]),
      get: vi
        .fn()
        .mockImplementation(async (id: number) => ({
          id,
          url: 'https://www.amazon.com/s?k=books',
        })),
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

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await db.delete();
  await db.open();
  useCollectionStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('H-5b: deterministic recovery', () => {
  it('restores the chronologically most recent session when lexicographic order disagrees', async () => {
    // '10_...' sorts BEFORE '9_...' lexicographically but is the OLDER run.
    // Before Step 4.3, `.first()` restored the tab-10 session — this is the
    // case that fails today.
    const now = Date.now();
    await db.sessions.bulkPut([
      sessionRow({
        id: '10_1000',
        tabId: 10,
        status: 'collecting',
        collectedCount: 11,
        startedAt: new Date(now - 2 * 3600_000).toISOString(),
      }),
      sessionRow({
        id: '9_2000',
        tabId: 9,
        status: 'collecting',
        collectedCount: 22,
        startedAt: new Date(now - 1 * 3600_000).toISOString(),
      }),
      sessionRow({
        id: '8_500',
        tabId: 8,
        status: 'completed',
        collectedCount: 99,
        startedAt: new Date(now - 3 * 3600_000).toISOString(),
      }),
    ]);

    const listeners: OnMessageListener[] = [];
    stubBrowserForApp(listeners);
    render(<TrackerWithRecovery />);

    await waitFor(() =>
      expect(useCollectionStore.getState().collectionTabId).toBe(9)
    );
    const store = useCollectionStore.getState();
    expect(store.collectedCount).toBe(22); // the tab-9 run, not tab-10's 11
    expect(store.status).toBe('idle'); // 'collecting' recovery → resume prompt
    expect(
      await screen.findByText(/Previous collection had 22 products/)
    ).toBeTruthy();
  });
});

describe('H-5b: pruneOldSessions', () => {
  it('removes stale terminal sessions with their products; keeps recent and active ones', async () => {
    const now = Date.now();
    await db.sessions.bulkPut([
      sessionRow({
        id: 's_old',
        status: 'completed',
        startedAt: new Date(now - 31 * DAY).toISOString(),
        updatedAt: new Date(now - 31 * DAY).toISOString(),
      }),
      sessionRow({
        id: 's_new',
        status: 'interrupted',
        startedAt: new Date(now - 1 * DAY).toISOString(),
        updatedAt: new Date(now - 1 * DAY).toISOString(),
      }),
      sessionRow({
        id: 's_active',
        status: 'collecting',
        startedAt: new Date(now - 31 * DAY).toISOString(),
        updatedAt: new Date(now - 31 * DAY).toISOString(),
      }),
    ]);
    await db.products.bulkPut([
      { asin: 'B0OLD', url: 'u', collectedAt: 'x', sessionKey: 's_old', source: 'search' },
      { asin: 'B0OLD2', url: 'u', collectedAt: 'x', sessionKey: 's_old', source: 'search' },
      { asin: 'B0NEW', url: 'u', collectedAt: 'x', sessionKey: 's_new', source: 'search' },
    ]);

    const removed = await pruneOldSessions();
    expect(removed).toBe(1);
    expect(await db.sessions.get('s_old')).toBeUndefined();
    expect(await db.sessions.get('s_new')).toBeTruthy(); // recent terminal kept
    expect(await db.sessions.get('s_active')).toBeTruthy(); // active never touched
    const asins = (await db.products.toArray()).map((p) => p.asin).sort();
    expect(asins).toEqual(['B0NEW']); // only the stale session's products gone
  });

  it('runs once per panel open from App mount', async () => {
    const now = Date.now();
    await db.sessions.put(
      sessionRow({
        id: 's_stale',
        status: 'completed',
        startedAt: new Date(now - 40 * DAY).toISOString(),
        updatedAt: new Date(now - 40 * DAY).toISOString(),
      })
    );

    const listeners: OnMessageListener[] = [];
    stubBrowserForApp(listeners);
    const { default: App } = await import('@/entrypoints/sidepanel/App');
    render(<App />);

    await waitFor(async () => {
      expect(await db.sessions.get('s_stale')).toBeUndefined();
    });
  });
});
