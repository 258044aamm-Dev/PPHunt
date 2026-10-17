import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { OPENING_MODE_KEY, readOpeningMode } from '@/lib/ui/openingMode';

type Listener = (...args: any[]) => void;
function event() {
  let listener: Listener = () => {};
  return {
    addListener: vi.fn((callback: Listener) => { listener = callback; }),
    emit: (...args: any[]) => listener(...args),
  };
}

async function startBackground(savedMode?: string) {
  const changed = event();
  const clicked = event();
  const storageGet = vi.fn().mockResolvedValue({ [OPENING_MODE_KEY]: savedMode });
  const mockBrowser = {
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setPopup: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      onClicked: clicked,
    },
    storage: { local: { get: storageGet }, onChanged: changed },
    tabs: { onActivated: event(), onUpdated: event(), onRemoved: event() },
    runtime: { onMessage: event(), getURL: vi.fn().mockReturnValue('chrome-extension://extension-id/overlay.html') },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
  };
  vi.stubGlobal('browser', mockBrowser);
  vi.stubGlobal('defineBackground', (main: () => void) => main);
  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
  await waitFor(() => expect(mockBrowser.action.setPopup).toHaveBeenCalled());
  return { browser: mockBrowser, changed, clicked, storageGet };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('toolbar mode routing', () => {
  it('keeps the chooser for an absent or unrecognized preference', async () => {
    expect(readOpeningMode(undefined)).toBeNull();
    expect(readOpeningMode('invalid')).toBeNull();
    const { browser } = await startBackground();
    expect(browser.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
    expect(browser.action.setPopup).toHaveBeenLastCalledWith({ popup: 'popup.html' });
    expect(browser.sidePanel.open).not.toHaveBeenCalled();
  });

  it('opens a saved sidebar directly, including a legacy preference, then restores the chooser', async () => {
    expect(readOpeningMode('sidepanel')).toBe('sidePanel');
    const { browser, changed, clicked } = await startBackground('sidepanel');
    expect(browser.action.setPopup).toHaveBeenLastCalledWith({ popup: '' });
    clicked.emit({ id: 7, url: 'https://example.org/' });
    await waitFor(() => expect(browser.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 }));

    changed.emit({ [OPENING_MODE_KEY]: { oldValue: 'sidepanel', newValue: undefined } }, 'local');
    expect(browser.action.setPopup).toHaveBeenLastCalledWith({ popup: 'popup.html' });
  });

  it('injects the saved overlay on ordinary pages, but falls back on browser pages', async () => {
    const { browser, clicked } = await startBackground('overlay');
    clicked.emit({ id: 8, url: 'https://example.org/article' });
    await waitFor(() => expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 8 },
      args: ['chrome-extension://extension-id/overlay.html', 400],
      func: expect.any(Function),
    })));
    expect(browser.sidePanel.open).not.toHaveBeenCalled();

    clicked.emit({ id: 9, url: 'chrome://settings/' });
    await waitFor(() => expect(browser.sidePanel.open).toHaveBeenCalledWith({ tabId: 9 }));
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    expect(browser.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('does not let an initial storage read overwrite a newer mode change', async () => {
    let finishRead!: (value: Record<string, unknown>) => void;
    const read = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
    const changed = event();
    const clicked = event();
    const action = {
      setPopup: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      onClicked: clicked,
    };
    vi.stubGlobal('browser', {
      action,
      sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
      storage: { local: { get: vi.fn().mockReturnValue(read) }, onChanged: changed },
      runtime: { onMessage: event() },
      tabs: { onActivated: event(), onUpdated: event(), onRemoved: event() },
    });
    vi.stubGlobal('defineBackground', (main: () => void) => main);
    const { default: main } = await import('@/entrypoints/background');
    (main as unknown as () => void)();
    await waitFor(() => expect(browser.storage.local.get).toHaveBeenCalled());
    changed.emit({ [OPENING_MODE_KEY]: { newValue: 'overlay' } }, 'local');
    finishRead({});
    await waitFor(() => expect(action.setPopup).toHaveBeenCalledWith({ popup: '' }));
    expect(action.setPopup).not.toHaveBeenCalledWith({ popup: 'popup.html' });
  });
});
