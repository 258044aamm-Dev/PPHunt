import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollectionControls } from '@/entrypoints/sidepanel/components/CollectionControls';
import { ErrorModal } from '@/entrypoints/sidepanel/components/ErrorModal';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { db } from '@/lib/db/database';

describe('collection commands after switching the viewed tab', () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useCollectionStore.getState().reset();
    sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { runtime: { sendMessage } });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('keeps pause/resume/stop and history attached to the original Amazon tab', async () => {
    const amazonUrl = 'https://www.amazon.com/s?k=books';
    useCollectionStore.getState().setActiveTab(10, amazonUrl, true);
    render(<CollectionControls />);
    fireEvent.click(screen.getByRole('button', { name: /Start$/ }));
    await waitFor(() => expect(useCollectionStore.getState().status).toBe('collecting'));
    expect(useCollectionStore.getState().collectionTabId).toBe(10);

    useCollectionStore.getState().setActiveTab(11, 'https://example.org/', false);
    fireEvent.click(screen.getByRole('button', { name: /Pause$/ }));
    await waitFor(() => expect(useCollectionStore.getState().status).toBe('paused'));
    fireEvent.click(screen.getByRole('button', { name: /Resume$/ }));
    await waitFor(() => expect(useCollectionStore.getState().status).toBe('collecting'));
    fireEvent.click(screen.getByRole('button', { name: /Stop$/ }));
    await waitFor(async () => expect(await db.history.count()).toBe(1));

    expect(sendMessage.mock.calls.map(([message]) => [message.type, message.payload.tabId])).toEqual([
      ['START_COLLECTION', 10], ['PAUSE_COLLECTION', 10],
      ['RESUME_COLLECTION', 10], ['STOP_COLLECTION', 10],
    ]);
    expect((await db.history.toArray())[0]?.url).toBe(amazonUrl);
    expect(useCollectionStore.getState().activeTabId).toBe(11);
    expect(useCollectionStore.getState().collectionTabId).toBeNull();
  });

  it('retries on the collection tab even when the viewed tab is different', () => {
    render(<ErrorModal />);
    act(() => {
      const store = useCollectionStore.getState();
      store.setActiveTab(11, 'https://example.org/', false);
      store.setCollectionTab(10, 'https://www.amazon.com/');
      store.setError('CAPTCHA detected');
      store.setStatus('error');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry collection' }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'START_COLLECTION',
      payload: expect.objectContaining({ tabId: 10 }),
    }));
  });
});
