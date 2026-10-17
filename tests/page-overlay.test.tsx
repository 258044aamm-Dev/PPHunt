import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Header } from '@/entrypoints/sidepanel/components/Header';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  isOverlayAllowed,
  openOverlayForTab,
  setOverlayFullWidthMode,
} from '@/lib/overlay/openOverlay';
import { mountOverlayHost } from '@/lib/overlay/overlayHost';

afterEach(() => {
  cleanup();
  document.getElementById('pphunt-extension-overlay-host')?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('page overlay', () => {
  it('adds a close control only in overlay mode, without changing the sidebar header', () => {
    const close = vi.fn();
    const view = render(<Header onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close overlay' }));
    expect(close).toHaveBeenCalledOnce();
    view.rerender(<Header />);
    expect(screen.queryByRole('button', { name: 'Close overlay' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('accepts regular HTTP(S) pages but not browser-internal pages', () => {
    expect(isOverlayAllowed('https://example.org/article')).toBe(true);
    expect(isOverlayAllowed('http://localhost:8080')).toBe(true);
    expect(isOverlayAllowed('chrome://extensions')).toBe(false);
    expect(isOverlayAllowed('https://chromewebstore.google.com/detail/sample')).toBe(false);
    expect(isOverlayAllowed('file:///tmp/test.html')).toBe(false);
    expect(isOverlayAllowed(undefined)).toBe(false);
  });

  it('injects on demand with the remembered width and checks the injection result', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ result: true }]);
    vi.stubGlobal('browser', {
      scripting: { executeScript },
      storage: { local: { get: vi.fn().mockResolvedValue({ pphuntOverlayWidth: 550 }) } },
      runtime: { getURL: vi.fn().mockReturnValue('chrome-extension://extension-id/overlay.html') },
    });
    await openOverlayForTab(13, 'https://example.net/');
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 13 },
      func: mountOverlayHost,
      args: ['chrome-extension://extension-id/overlay.html', 550],
    });
    executeScript.mockResolvedValueOnce([{ result: false }]);
    await expect(openOverlayForTab(13, 'https://example.net/')).rejects.toThrow(/could not be created/i);
    await expect(openOverlayForTab(13, 'chrome://settings')).rejects.toThrow(/unavailable here/i);
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('mounts an isolated, resizable extension iframe exactly once and closes on its own message', () => {
    const savedWidth = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { storage: { local: { set: savedWidth } } });
    const elements = vi.spyOn(document, 'createElement');
    const url = 'chrome-extension://extension-id/overlay.html';
    expect(mountOverlayHost(url, 400)).toBe(true);
    expect(mountOverlayHost(url, 400)).toBe(true);
    const host = document.getElementById('pphunt-extension-overlay-host')!;
    expect(document.querySelectorAll('#pphunt-extension-overlay-host')).toHaveLength(1);
    expect(host.shadowRoot).toBeNull(); // closed shadow root: page CSS cannot restyle the UI
    expect(host.style.width).toBe('400px');
    const created = elements.mock.results.map((call) => call.value as HTMLElement);
    const frame = created.find((element) => element?.tagName === 'IFRAME') as HTMLIFrameElement;
    const handle = created.find((element) => element?.getAttribute?.('aria-label') === 'Resize PPHunt overlay')!;
    expect(frame.src).toBe(url);
    expect(document.querySelector('iframe')).toBeNull(); // iframe stays in the shadow tree

    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({
      width: Number.parseInt(host.style.width, 10),
    } as DOMRect));
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500 }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }));
    handle.dispatchEvent(new MouseEvent('pointerup'));
    expect(host.style.width).toBe('500px');
    expect(savedWidth).toHaveBeenCalledWith({ pphuntOverlayWidth: 500 });

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://example.net', source: frame.contentWindow,
      data: { type: 'PPHUNT_CLOSE_OVERLAY' },
    }));
    expect(host.isConnected).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'chrome-extension://extension-id', source: frame.contentWindow,
      data: { type: 'PPHUNT_CLOSE_OVERLAY' },
    }));
    expect(host.isConnected).toBe(false);
  });

  // M-4 (SAD-183): the outbound leak — overlay iframe messages must target
  // the extension origin, never '*', so host pages cannot observe them.
  it('setOverlayFullWidthMode targets window.location.origin, not "*"', () => {
    const parentPostMessage = vi.fn();
    const realParent = window.parent;
    Object.defineProperty(window, 'parent', {
      value: { postMessage: parentPostMessage },
      configurable: true,
    });
    try {
      setOverlayFullWidthMode(true);
      setOverlayFullWidthMode(false);
    } finally {
      Object.defineProperty(window, 'parent', {
        value: realParent,
        configurable: true,
      });
    }
    expect(parentPostMessage).toHaveBeenCalledTimes(2);
    expect(parentPostMessage).toHaveBeenCalledWith(
      { type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth: true },
      window.location.origin
    );
    expect(parentPostMessage).toHaveBeenCalledWith(
      { type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth: false },
      window.location.origin
    );
    for (const call of parentPostMessage.mock.calls) {
      expect(call[1]).not.toBe('*');
    }
  });

  it('round-trip: an extension-origin FULLWIDTH message still widens the host', () => {
    const savedWidth = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { storage: { local: { set: savedWidth } } });
    const elements = vi.spyOn(document, 'createElement');
    const url = 'chrome-extension://extension-id/overlay.html';
    expect(mountOverlayHost(url, 400)).toBe(true);
    const host = document.getElementById('pphunt-extension-overlay-host')!;
    const created = elements.mock.results.map((call) => call.value as HTMLElement);
    const frame = created.find((element) => element?.tagName === 'IFRAME') as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'chrome-extension://extension-id',
      source: frame.contentWindow,
      data: { type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth: true },
    }));
    expect(host.getAttribute('data-fullwidth')).toBe('true');
    const widened = Number.parseInt(host.style.width, 10);
    expect(widened).toBeGreaterThan(400);

    // and the restore direction works too
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'chrome-extension://extension-id',
      source: frame.contentWindow,
      data: { type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth: false },
    }));
    expect(host.getAttribute('data-fullwidth')).toBeNull();
  });
});

/**
 * Exit-criterion guard: no postMessage(..., '*') may exist anywhere in src/.
 * Scans every .ts/.tsx source file — the mechanism that keeps this class of
 * leak from coming back.
 */
describe('M-4: no postMessage to a wildcard origin in src/', () => {
  it('source scan finds zero "*" targetOrigin calls', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry: string) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.(ts|tsx)$/.test(full) ? [full] : [];
      });
    const offenders: string[] = [];
    for (const file of walk(resolve(__dirname, '../src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.postMessage\(([\s\S]{0,300}?)\)\s*;/g)) {
        if (/'\*'|"\*"/.test(m[1] ?? '')) {
          offenders.push(file.replace(/^.*\/src\//, 'src/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
