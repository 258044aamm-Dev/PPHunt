/**
 * Step 4.1 (SAD-172) — H-5a: History records a real duration, and
 * updateSessionStatus is an upsert that never silently drops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/database';
import {
  createSession,
  ensureSession,
  getActiveSession,
  getSession,
  updateSessionStatus,
  reconcileInterruptedSessions,
} from '@/lib/db/sessions';
import { clampTargetCount, TARGET_MIN, TARGET_MAX } from '@/constants/defaults';
import { SettingsSchema } from '@/lib/schemas/settings';
import { StartCollectionMessageSchema } from '@/lib/schemas/messages';
import { StatusBar } from '@/entrypoints/sidepanel/components/StatusBar';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useToastStore } from '@/entrypoints/sidepanel/components/ToastContainer';

const T0 = Date.parse('2026-10-17T08:00:00.000Z');

type OnMessageListener = (msg: unknown, sender?: unknown) => unknown;

function stubBrowserForApp(listeners: OnMessageListener[], tabUrl: string) {
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: OnMessageListener) => {
          listeners.push(fn);
        },
        removeListener: vi.fn(),
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

beforeEach(async () => {
  await db.delete();
  await db.open();
  useCollectionStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('H-5a: session rows and real durations (DB layer)', () => {
  it('records a real duration: createSession -> +30s -> updateSessionStatus(completed)', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const key = await createSession(9, 'https://www.amazon.com/s?k=x', 'manual', 50);
    vi.setSystemTime(T0 + 30_000);
    await updateSessionStatus(key, 'completed', { collected: 12 });

    const row = await getSession(key);
    expect(row).toBeTruthy();
    expect(row!.startedAt).toBe(new Date(T0).toISOString());
    expect(
      Date.parse(row!.completedAt!) - Date.parse(row!.startedAt)
    ).toBe(30_000); // fails before Step 4.1 only via CollectionControls; here the row was always right
  });

  it('updateSessionStatus is an upsert: a missing key gets a row instead of a silent no-op', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    await updateSessionStatus('7_12345', 'completed', { collected: 5, target: 40 });

    const row = await getSession('7_12345');
    expect(row).toBeTruthy(); // was silently dropped before Step 4.1
    expect(row!.tabId).toBe(7); // parsed from the key
    expect(row!.status).toBe('completed');
    expect(row!.collectedCount).toBe(5);
    expect(row!.targetCount).toBe(40);
    expect(row!.startedAt).toBe(new Date(T0).toISOString());
    expect(row!.completedAt).toBe(new Date(T0).toISOString());
  });

  it('tolerates the legacy `session_${tabId}_${ts}` key format for in-flight sessions', async () => {
    await updateSessionStatus('session_9_555', 'error', undefined, 'boom');
    const row = await getSession('session_9_555');
    expect(row).toBeTruthy();
    expect(row!.tabId).toBe(9);
    expect(row!.errorMessage).toBe('boom');
  });

  it('preserves the original startedAt when the row already exists', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const key = await createSession(3, 'https://www.amazon.com/s?k=y');
    vi.setSystemTime(T0 + 60_000);
    await updateSessionStatus(key, 'paused', { collected: 2 });

    const row = await getSession(key);
    expect(row!.startedAt).toBe(new Date(T0).toISOString()); // unchanged
    expect(row!.updatedAt).toBe(new Date(T0 + 60_000).toISOString());
  });

  it('ensureSession creates a row for the exact key and never clobbers an existing one', async () => {
    const key = `42_${Date.now()}`;
    const startedAt = new Date(T0).toISOString();
    const returned = await ensureSession(
      key,
      42,
      'https://www.amazon.com/s?k=z',
      'automatic',
      250,
      startedAt
    );
    expect(returned).toBe(key);
    const row = await getSession(key);
    expect(row).toMatchObject({
      tabId: 42,
      url: 'https://www.amazon.com/s?k=z',
      status: 'collecting',
      mode: 'automatic',
      targetCount: 250,
      startedAt,
    });

    // second call with different values must be a no-op
    await ensureSession(key, 99, 'https://evil.example/', 'manual', 1, 'x');
    const after = await getSession(key);
    expect(after).toMatchObject({ tabId: 42, url: 'https://www.amazon.com/s?k=z', startedAt });
  });

  it('getActiveSession picks the most RECENT session, not the lexicographically-lowest key', async () => {
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    // '10_...' sorts before '9_...' lexicographically but is the OLDER run.
    await db.sessions.bulkPut([
      {
        id: '10_100',
        tabId: 10,
        url: 'https://www.amazon.com/s?old=1',
        status: 'collecting',
        mode: 'manual',
        targetCount: 50,
        collectedCount: 0,
        startedAt: new Date(base - 2 * 3600_000).toISOString(),
      },
      {
        id: '9_200',
        tabId: 9,
        url: 'https://www.amazon.com/s?new=1',
        status: 'collecting',
        mode: 'manual',
        targetCount: 50,
        collectedCount: 0,
        startedAt: new Date(base - 1 * 3600_000).toISOString(),
      },
    ]);

    const active = await getActiveSession();
    expect(active!.id).toBe('9_200'); // chronologically most recent
  });
});

describe('H-5a: CollectionControls writes the real startedAt into History', () => {
  it('start -> +30s -> stop yields a History row with a 30s duration (was 0 before)', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const listeners: OnMessageListener[] = [];
    stubBrowserForApp(listeners, 'https://www.amazon.com/s?k=books');

    const { default: App } = await import('@/entrypoints/sidepanel/App');
    render(<App />);

    const startBtn = await screen.findByRole('button', { name: /Start/ });
    await waitFor(() =>
      expect((startBtn as HTMLButtonElement).disabled).toBe(false)
    );

    fireEvent.click(startBtn);
    const stopBtn = await screen.findByRole('button', { name: /Stop/ });

    // one session row exists now, created at T0
    await waitFor(async () => expect(await db.sessions.count()).toBe(1));

    vi.setSystemTime(T0 + 30_000);
    fireEvent.click(stopBtn);

    await waitFor(async () => expect(await db.history.count()).toBe(1));
    const entry = (await db.history.toArray())[0]!;
    const sessionRow = (await db.sessions.toArray())[0]!;
    expect(entry.startedAt).toBe(sessionRow.startedAt); // real start, not the stop time
    expect(entry.startedAt).toBe(new Date(T0).toISOString());
    expect(Date.parse(entry.completedAt) - Date.parse(entry.startedAt)).toBe(
      30_000
    ); // fails before Step 4.1: delta was 0
  });
});

describe('H-5a: HistoryEntry renders the start time, not the end time', () => {
  it('shows formatDate(startedAt) on the card', async () => {
    const startedAt = '2026-10-16T09:00:00.000Z';
    const completedAt = '2026-10-16T18:30:00.000Z';
    await db.history.add({
      sessionKey: 'session_render',
      url: 'https://www.amazon.com/s?k=render',
      mode: 'manual',
      targetCount: 50,
      collectedCount: 3,
      startedAt,
      completedAt,
      status: 'completed',
    });

    const listeners: OnMessageListener[] = [];
    stubBrowserForApp(listeners, 'https://example.com/');
    const { default: App } = await import('@/entrypoints/sidepanel/App');
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));

    const card = await screen.findByTestId('history-entry-session_render');
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    expect(card.textContent).toContain(fmt(startedAt));
    expect(card.textContent).not.toContain(fmt(completedAt));
  });
});

/* ── Step 9.4 (SAD-197): L-5 'interrupted' status + L-1 targetCount bounds ── */

describe('Step 9.4 (SAD-197): interrupted status + targetCount bounds', () => {
  beforeEach(async () => {
    await db.open();
    await db.sessions.clear();
    useCollectionStore.getState().reset();
  });

  afterEach(cleanup);

  it('schemas reject 0, -1, 1.5 and above max; accept 1 and max', () => {
    const target = SettingsSchema.shape.defaultTargetCount;
    for (const bad of [0, -1, 1.5, TARGET_MAX + 1]) {
      expect(target.safeParse(bad).success).toBe(false);
    }
    expect(target.safeParse(TARGET_MIN).success).toBe(true);
    expect(target.safeParse(TARGET_MAX).success).toBe(true);

    // Same bounds on the wire schema for START_COLLECTION.
    const msg = (targetCount: number) => ({
      type: 'START_COLLECTION' as const,
      payload: { mode: 'manual' as const, targetCount, tabId: 1 },
    });
    for (const bad of [0, -1, 1.5, TARGET_MAX + 1]) {
      expect(StartCollectionMessageSchema.safeParse(msg(bad)).success).toBe(false);
    }
    expect(StartCollectionMessageSchema.safeParse(msg(TARGET_MIN)).success).toBe(true);
    expect(StartCollectionMessageSchema.safeParse(msg(TARGET_MAX)).success).toBe(true);
  });

  it('clampTargetCount guards the division-by-zero paths', () => {
    expect(clampTargetCount(0)).toBe(TARGET_MIN);
    expect(clampTargetCount(-5)).toBe(TARGET_MIN);
    expect(clampTargetCount(999999999)).toBe(TARGET_MAX);
    expect(clampTargetCount(2.7)).toBe(3);
    expect(clampTargetCount(NaN)).toBe(50); // DEFAULT_TARGET_COUNT
    expect(clampTargetCount(Infinity)).toBe(50);
  });

  it('store setTarget clamps at the single write path', () => {
    const store = useCollectionStore.getState();
    store.setTarget(0);
    expect(useCollectionStore.getState().targetCount).toBe(TARGET_MIN);
    store.setTarget(100000);
    expect(useCollectionStore.getState().targetCount).toBe(TARGET_MAX);
    store.setTarget(250);
    expect(useCollectionStore.getState().targetCount).toBe(250);
  });

  it('createSession clamps a bad targetCount before it reaches the row', async () => {
    const key = await createSession(7, 'https://www.amazon.com/s?k=x', 'manual', 0);
    const row = await getSession(key);
    expect(row?.targetCount).toBe(TARGET_MIN);
  });

  it('startup reconciliation flips collecting -> interrupted and touches nothing else', async () => {
    const stale = await createSession(11, 'https://www.amazon.com/s?k=stale');
    const pausedKey = await createSession(12, 'https://www.amazon.com/s?k=paused');
    await updateSessionStatus(pausedKey, 'paused', { collected: 3 });
    const doneKey = await createSession(13, 'https://www.amazon.com/s?k=done');
    await updateSessionStatus(doneKey, 'completed', { collected: 9 });

    const changed = await reconcileInterruptedSessions();
    expect(changed).toBe(1);

    const staleRow = await getSession(stale);
    expect(staleRow?.status).toBe('interrupted');
    expect(staleRow?.completedAt).toBeTruthy();
    expect((await getSession(pausedKey))?.status).toBe('paused');
    expect((await getSession(doneKey))?.status).toBe('completed');

    // The reconciled session is no longer "active"; the paused one still is
    // (getActiveSession treats paused as resumable — pre-existing design).
    const active = await getActiveSession();
    expect(active?.id).not.toBe(stale);
    expect(active?.status).toBe('paused');
  });

  it('StatusBar renders a visible, distinct style for interrupted', () => {
    useCollectionStore.setState({ status: 'interrupted' });
    render(<StatusBar />);
    const indicator = screen.getByRole('status');
    expect(indicator.getAttribute('aria-label')).toBe('Status: Interrupted');
    expect(screen.getByText('Interrupted')).toBeTruthy();
    expect(indicator.innerHTML).toContain('bg-golden');
  });
});
