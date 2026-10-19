/**
 * SAD-331 — the per-card save control must follow PPHunt's theme, not the OS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  syncCardActionTheme,
  toCardActionTheme,
  type CardActionTheme,
} from '@/engines/amazon/content/card-action-theme';
import { createCardActionLayer } from '@/engines/amazon/content/card-action-layer';

const CARD_HTML = `
  <div data-component-type="s-search-result" data-asin="B0AAAAAAAA">
    <h2><a href="/Test-A/dp/B0AAAAAAAA"><span>Product A</span></a></h2>
  </div>
  <div data-component-type="s-search-result" data-asin="B0BBBBBBBB">
    <h2><a href="/Test-B/dp/B0BBBBBBBB"><span>Product B</span></a></h2>
  </div>
`;

function fakeBrowser(stored: Record<string, unknown> = {}) {
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  const removeListener = vi.fn((listener: (changes: Record<string, unknown>, area: string) => void) => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  });

  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
      },
      onChanged: {
        addListener: (listener: (changes: Record<string, unknown>, area: string) => void) => {
          listeners.push(listener);
        },
        removeListener,
      },
    },
    /** Simulates the side panel writing a new value. */
    emit(changes: Record<string, unknown>, area = 'local') {
      for (const listener of [...listeners]) listener(changes, area);
    },
    get listenerCount() {
      return listeners.length;
    },
    removeListener,
  };
}

describe('toCardActionTheme', () => {
  it('passes an explicit choice straight through', () => {
    expect(toCardActionTheme('dark')).toBe('dark');
    expect(toCardActionTheme('light')).toBe('light');
  });

  it("maps 'system' to the control's own 'auto' rather than freezing a value", () => {
    // Resolving here would stop the control reacting to an OS change.
    expect(toCardActionTheme('system')).toBe('auto');
  });
});

describe('syncCardActionTheme', () => {
  it('applies the stored theme on start', async () => {
    const target = { setTheme: vi.fn() };
    const browser = fakeBrowser({ pphuntTheme: 'dark' });

    syncCardActionTheme(target, browser);
    await Promise.resolve();
    await Promise.resolve();

    expect(target.setTheme).toHaveBeenCalledWith('dark');
  });

  it('falls back to auto when nothing is stored', async () => {
    const target = { setTheme: vi.fn() };
    syncCardActionTheme(target, fakeBrowser());

    await vi.waitFor(() => expect(target.setTheme).toHaveBeenCalledWith('auto'));
  });

  it('treats an unrecognised stored value as auto, not as dark', async () => {
    const target = { setTheme: vi.fn() };
    syncCardActionTheme(target, fakeBrowser({ pphuntTheme: 'purple' }));

    await vi.waitFor(() => expect(target.setTheme).toHaveBeenCalledWith('auto'));
  });

  it('follows a later change without a reload', async () => {
    const target = { setTheme: vi.fn() };
    const browser = fakeBrowser({ pphuntTheme: 'light' });
    syncCardActionTheme(target, browser);
    await vi.waitFor(() => expect(target.setTheme).toHaveBeenCalledWith('light'));

    browser.emit({ pphuntTheme: { newValue: 'dark' } });
    expect(target.setTheme).toHaveBeenLastCalledWith('dark');

    browser.emit({ pphuntTheme: { newValue: 'system' } });
    expect(target.setTheme).toHaveBeenLastCalledWith('auto');
  });

  it('ignores other keys and other storage areas', async () => {
    const target = { setTheme: vi.fn() };
    const browser = fakeBrowser({ pphuntTheme: 'dark' });
    syncCardActionTheme(target, browser);
    await vi.waitFor(() => expect(target.setTheme).toHaveBeenCalledTimes(1));

    browser.emit({ somethingElse: { newValue: 'dark' } });
    browser.emit({ pphuntTheme: { newValue: 'light' } }, 'sync');
    expect(target.setTheme).toHaveBeenCalledTimes(1);

    browser.emit({ pphuntTheme: { newValue: 'light' } });
    expect(target.setTheme).toHaveBeenLastCalledWith('light');
  });

  it('removes its listener on dispose, so nothing leaks across navigations', async () => {
    const target = { setTheme: vi.fn() };
    const browser = fakeBrowser({ pphuntTheme: 'dark' });
    const dispose = syncCardActionTheme(target, browser);
    await vi.waitFor(() => expect(target.setTheme).toHaveBeenCalledTimes(1));

    expect(browser.listenerCount).toBe(1);
    dispose();

    expect(browser.removeListener).toHaveBeenCalledTimes(1);
    expect(browser.listenerCount).toBe(0);

    browser.emit({ pphuntTheme: { newValue: 'light' } });
    expect(target.setTheme).toHaveBeenCalledTimes(1);
  });

  it('survives a browser without storage at all', () => {
    const target = { setTheme: vi.fn() };
    expect(() => syncCardActionTheme(target, {})()).not.toThrow();
    expect(target.setTheme).not.toHaveBeenCalled();
  });
});

describe('the layer applies a theme to controls that are already mounted', () => {
  beforeEach(() => {
    document.body.innerHTML = CARD_HTML;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mountBoth() {
    const layer = createCardActionLayer({ onSave: vi.fn(), theme: 'auto' });
    const cards = [...document.querySelectorAll('[data-asin]')];
    for (const card of cards) layer.mountCard(card);
    return layer;
  }

  it('updates every mounted control', () => {
    const layer = mountBoth();
    const hosts = [...document.querySelectorAll('[data-pphunt-save-host]')];
    expect(hosts).toHaveLength(2);
    expect(hosts.map((host) => host.getAttribute('data-theme'))).toEqual(['auto', 'auto']);

    layer.setTheme('dark');

    expect(hosts.map((host) => host.getAttribute('data-theme'))).toEqual(['dark', 'dark']);
  });

  it('applies the latest theme to cards that mount afterwards', () => {
    const layer = mountBoth();
    layer.setTheme('dark');

    const late = document.createElement('div');
    late.setAttribute('data-asin', 'B0CCCCCCCC');
    late.innerHTML = '<h2><a href="/Test-C/dp/B0CCCCCCCC"><span>Product C</span></a></h2>';
    document.body.appendChild(late);

    const handle = layer.mountCard(late);
    expect(handle?.host.getAttribute('data-theme')).toBe('dark');
  });

  it('keeps working with no controls mounted', () => {
    const layer = createCardActionLayer({ onSave: vi.fn() });
    expect(() => layer.setTheme('light')).not.toThrow();
  });
});

describe('end to end: stored dark reaches the control while the OS is light', () => {
  it('pushes dark onto both cards without a reload', async () => {
    // The OS says light...
    const media = vi.fn().mockReturnValue(false);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: media(query),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    document.body.innerHTML = CARD_HTML;

    const layer = createCardActionLayer({ onSave: vi.fn(), theme: 'auto' });
    for (const card of document.querySelectorAll('[data-asin]')) layer.mountCard(card);

    // ...but PPHunt is set to dark.
    const browser = fakeBrowser({ pphuntTheme: 'dark' });
    const dispose = syncCardActionTheme(layer, browser);

    await vi.waitFor(() => {
      const themes = [...document.querySelectorAll('[data-pphunt-save-host]')].map((host) =>
        host.getAttribute('data-theme'),
      );
      expect(themes).toEqual(['dark', 'dark']);
    });

    // And a later switch is applied without re-mounting anything.
    browser.emit({ pphuntTheme: { newValue: 'light' } });
    const themes = [...document.querySelectorAll('[data-pphunt-save-host]')].map((host) =>
      host.getAttribute('data-theme'),
    );
    expect(themes).toEqual(['light', 'light']);

    dispose();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });
});

describe('type surface', () => {
  it('accepts exactly the three palettes the stylesheet defines', () => {
    const themes: CardActionTheme[] = ['auto', 'light', 'dark'];
    expect(themes).toHaveLength(3);
  });
});
