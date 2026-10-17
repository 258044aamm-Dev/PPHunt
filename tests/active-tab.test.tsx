import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useActiveBrowserTab } from '@/entrypoints/sidepanel/hooks/useActiveBrowserTab';
import { CollectTab } from '@/entrypoints/sidepanel/components/CollectTab';
import { useSessionRecovery } from '@/entrypoints/sidepanel/hooks/useSessionRecovery';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { isAmazonUrl } from '@/lib/utils/amazon-url';
import { db } from '@/lib/db/database';
import { createSession, updateSessionStatus } from '@/lib/db/sessions';

type Tab = { id: number; windowId: number; active: boolean; url: string };

function makeEvent<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => { listeners.add(listener); }),
    removeListener: vi.fn((listener: T) => { listeners.delete(listener); }),
    emit: (...args: Parameters<T>) => { for (const listener of listeners) listener(...args); },
    get size() { return listeners.size; },
  };
}

function PageTracker() {
  useActiveBrowserTab();
  return null;
}

function TrackerWithRecovery() {
  useActiveBrowserTab();
  useSessionRecovery();
  return null;
}

describe('active tab tracking', () => {
  let currentTab: Tab | undefined;
  let query: ReturnType<typeof vi.fn>;
  let onActivated: ReturnType<typeof makeEvent<(info: { tabId: number; windowId: number }) => void>>;
  let onUpdated: ReturnType<typeof makeEvent<(id: number, change: { url?: string; status?: string }, tab: Tab) => void>>;
  let onRemoved: ReturnType<typeof makeEvent<(id: number) => void>>;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useCollectionStore.getState().reset();
    currentTab = { id: 7, windowId: 1, active: true, url: 'https://example.com/' };
    query = vi.fn(async () => currentTab ? [currentTab] : []);
    onActivated = makeEvent();
    onUpdated = makeEvent();
    onRemoved = makeEvent();
    vi.stubGlobal('browser', {
      tabs: {
        query,
        get: vi.fn(async (id: number) => ({ id, url: 'https://www.amazon.com/s?k=books' })),
        onActivated,
        onUpdated,
        onRemoved,
      },
    });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('updates the open sidebar in both directions on navigation and tab switches', async () => {
    render(<StrictMode><PageTracker /><CollectTab /></StrictMode>);
    await waitFor(() => expect(useCollectionStore.getState().activeTabId).toBe(7));
    expect(screen.getByText(/Not on Amazon/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Start$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(onUpdated.size).toBe(1); // StrictMode cleanup must not leak listeners.

    currentTab = { id: 7, windowId: 1, active: true, url: 'https://www.amazon.com/s?k=books' };
    act(() => onUpdated.emit(7, { url: currentTab!.url }, currentTab!));
    await waitFor(() => expect(screen.queryByText(/Not on Amazon/)).toBeNull());
    expect((screen.getByRole('button', { name: /Start$/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(useCollectionStore.getState().activeTabUrl).toBe(currentTab.url);

    currentTab = { id: 8, windowId: 1, active: true, url: 'https://example.org/' };
    act(() => onActivated.emit({ tabId: 8, windowId: 1 }));
    await waitFor(() => expect(useCollectionStore.getState().activeTabId).toBe(8));
    expect(screen.getByText(/Not on Amazon/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Start$/ }) as HTMLButtonElement).disabled).toBe(true);

    const before = query.mock.calls.length;
    act(() => onUpdated.emit(99, { url: 'https://www.amazon.com/' }, {
      id: 99, windowId: 2, active: true, url: 'https://www.amazon.com/',
    }));
    expect(query).toHaveBeenCalledTimes(before); // Other windows must not change this sidebar.

    currentTab = undefined;
    act(() => onRemoved.emit(8));
    await waitFor(() => expect(useCollectionStore.getState().activeTabId).toBeNull());
    expect(useCollectionStore.getState().activeTabUrl).toBeNull();
  });

  it('ignores a slow, obsolete tab query after navigation', async () => {
    let resolveFirst!: (tabs: Tab[]) => void;
    query.mockImplementationOnce(() => new Promise<Tab[]>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => [{ id: 9, windowId: 1, active: true, url: 'https://amazon.co.uk/dp/123' }]);

    render(<PageTracker />);
    act(() => onActivated.emit({ tabId: 9, windowId: 1 }));
    await waitFor(() => expect(useCollectionStore.getState().activeTabId).toBe(9));
    await act(async () => { resolveFirst([{ id: 7, windowId: 1, active: true, url: 'https://example.com/' }]); });
    expect(useCollectionStore.getState().isAmazonPage).toBe(true);
  });

  it('restores a collection without replacing the tab currently in view', async () => {
    const sessionKey = await createSession(42, 'https://www.amazon.com/s?k=books', 'manual', 50);
    await updateSessionStatus(sessionKey, 'paused');
    render(<TrackerWithRecovery />);

    await waitFor(() => expect(useCollectionStore.getState().collectionTabId).toBe(42));
    expect(useCollectionStore.getState().activeTabId).toBe(7);
    expect(useCollectionStore.getState().isAmazonPage).toBe(false);
    expect(useCollectionStore.getState().status).toBe('paused');
  });
});

describe('Amazon URL matching', () => {
  it('accepts supported Amazon hosts, not lookalikes or unsupported protocols', () => {
    expect(isAmazonUrl('https://www.amazon.com/s?k=books')).toBe(true);
    expect(isAmazonUrl('https://amazon.co.uk/dp/B012345678')).toBe(true);
    expect(isAmazonUrl('https://fakeamazon.com')).toBe(false);
    expect(isAmazonUrl('https://amazon.com.evil.example/')).toBe(false);
    expect(isAmazonUrl('chrome://settings')).toBe(false);
  });
});
