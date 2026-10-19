/**
 * SAD-281: the single, unobtrusive feedback element the one-click flow adds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  removeSaveToast,
  SAVE_TOAST_DEFAULT_MS,
  SAVE_TOAST_ID,
  showSaveToast,
} from '@/engines/amazon/content/toast';

function toast(): HTMLElement | null {
  return document.getElementById(SAVE_TOAST_ID);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  removeSaveToast();
  vi.useRealTimers();
});

describe('showSaveToast', () => {
  it('creates exactly one element and reuses it for later messages', () => {
    showSaveToast({ state: 'queued', message: 'Saving…' });
    showSaveToast({ state: 'completed', message: 'Saved' });

    expect(document.querySelectorAll(`#${SAVE_TOAST_ID}`)).toHaveLength(1);
    expect(toast()?.textContent).toBe('Saved');
    expect(toast()?.dataset.state).toBe('completed');
  });

  it('announces itself without capturing pointer events', () => {
    showSaveToast({ state: 'completed', message: 'Saved' });

    expect(toast()?.getAttribute('role')).toBe('status');
    expect(toast()?.getAttribute('aria-live')).toBe('polite');
    expect(toast()?.style.pointerEvents).toBe('none');
    expect(toast()?.style.position).toBe('fixed');
  });

  it('hides itself after the default timeout', () => {
    vi.useFakeTimers();
    showSaveToast({ state: 'queued', message: 'Saving…' });

    vi.advanceTimersByTime(SAVE_TOAST_DEFAULT_MS - 1);
    expect(toast()).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(toast()).toBeNull();
  });

  it('restarts the timer when a new state replaces the old one', () => {
    vi.useFakeTimers();
    showSaveToast({ state: 'queued', message: 'Saving…' });
    vi.advanceTimersByTime(SAVE_TOAST_DEFAULT_MS - 100);

    showSaveToast({ state: 'completed', message: 'Saved' });
    vi.advanceTimersByTime(SAVE_TOAST_DEFAULT_MS - 100);

    expect(toast()?.textContent).toBe('Saved');

    vi.advanceTimersByTime(101);
    expect(toast()).toBeNull();
  });

  it('stays until dismissed when autoHide is disabled', () => {
    vi.useFakeTimers();
    showSaveToast({ state: 'failed', message: 'Could not save', autoHideMs: 0 });

    vi.advanceTimersByTime(60_000);
    expect(toast()?.textContent).toBe('Could not save');
  });

  it('does nothing when the document has no body', () => {
    const detached = document.implementation.createHTMLDocument('empty');
    detached.body.remove();

    expect(() =>
      showSaveToast({ state: 'queued', message: 'Saving…', doc: detached }),
    ).not.toThrow();
  });
});

describe('removeSaveToast', () => {
  it('removes the element and cancels a pending hide', () => {
    vi.useFakeTimers();
    showSaveToast({ state: 'queued', message: 'Saving…' });
    removeSaveToast();

    expect(toast()).toBeNull();
    expect(() => vi.advanceTimersByTime(SAVE_TOAST_DEFAULT_MS)).not.toThrow();
  });

  it('is a no-op when nothing is shown', () => {
    expect(() => removeSaveToast()).not.toThrow();
  });
});
