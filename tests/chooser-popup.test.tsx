import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { OPENING_MODE_KEY } from '@/lib/ui/openingMode';

function preparePopup(url = 'https://example.org/') {
  document.body.innerHTML = `
    <button id="sidepanel" disabled>Open in Sidebar</button>
    <button id="overlay" disabled>Open in Overlay</button>
    <label><input id="remember" type="checkbox" /> Remember my choice</label>
    <p id="error" role="alert" hidden></p>`;
  const mockBrowser = {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42, url }]) },
    sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
    storage: { local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } },
    runtime: { getURL: vi.fn().mockReturnValue('chrome-extension://extension-id/overlay.html') },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
  };
  vi.stubGlobal('browser', mockBrowser);
  const close = vi.spyOn(window, 'close').mockImplementation(() => {});
  return { browser: mockBrowser, close };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('chooser popup', () => {
  it('opens the sidebar within the click and leaves the chooser active unless remembered', async () => {
    const { browser, close } = preparePopup();
    await import('@/entrypoints/popup/main');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open in Sidebar' }) as HTMLButtonElement).disabled).toBe(false));
    browser.sidePanel.open.mockImplementation(() => {
      // No asynchronous work is awaited before requesting the side panel.
      expect(browser.storage.local.remove).toHaveBeenCalledWith(OPENING_MODE_KEY);
      return Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open in Sidebar' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(browser.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('remembers a selected overlay and injects it on a non-Amazon webpage', async () => {
    const { browser, close } = preparePopup();
    await import('@/entrypoints/popup/main');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open in Overlay' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember my choice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Overlay' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42 }, args: ['chrome-extension://extension-id/overlay.html', 400],
    }));
    expect(browser.sidePanel.open).not.toHaveBeenCalled();
    expect(browser.storage.local.set).toHaveBeenCalledWith({ [OPENING_MODE_KEY]: 'overlay' });
  });

  it('shows a recoverable error instead of remembering overlay on a restricted page', async () => {
    const { browser, close } = preparePopup('chrome://extensions');
    await import('@/entrypoints/popup/main');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open in Overlay' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember my choice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Overlay' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/unavailable here/i));
    expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Open in Sidebar' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not retain a sidebar preference if opening fails', async () => {
    const { browser, close } = preparePopup();
    browser.sidePanel.open.mockRejectedValue(new Error('Panel cannot open'));
    await import('@/entrypoints/popup/main');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open in Sidebar' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember my choice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Sidebar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Panel cannot open'));
    expect(browser.storage.local.set).toHaveBeenCalledWith({ [OPENING_MODE_KEY]: 'sidePanel' });
    expect(browser.storage.local.remove).toHaveBeenCalledWith(OPENING_MODE_KEY);
    expect(close).not.toHaveBeenCalled();
  });
});
