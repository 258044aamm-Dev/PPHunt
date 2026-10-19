/**
 * SAD-287 (P3.3) - the Ask dialog.
 *
 * The dialog is the only new visible surface in the whole flow, so these tests
 * pin the things a user would notice if they broke: three buttons and no text
 * input, Escape/backdrop behaving like Cancel, one dialog at a time with a
 * truthful counter, a 30 s timeout that cancels, and focus going back where it
 * came from. The shadow root is opened here; production keeps it closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLLECTION_CHOICE_DIALOG_ID,
  COLLECTION_CHOICE_TIMEOUT_MS,
  createCollectionChoiceQueue,
  type CollectionChoice,
  type CollectionChoiceQueue,
} from '@/engines/amazon/content/collection-choice-dialog';

let queue: CollectionChoiceQueue | null = null;

function host(): HTMLElement | null {
  return document.getElementById(COLLECTION_CHOICE_DIALOG_ID);
}

function shadow(): ShadowRoot | null {
  return host()?.shadowRoot ?? null;
}

function query(selector: string): HTMLElement | null {
  return (shadow()?.querySelector(selector) as HTMLElement | null) ?? null;
}

function build(overrides: Partial<Parameters<typeof createCollectionChoiceQueue>[0]> = {}) {
  const onChoice = vi.fn<(jobId: string, choice: CollectionChoice) => void>();
  queue = createCollectionChoiceQueue({
    shadowMode: 'open',
    onChoice,
    ...overrides,
  });
  return { onChoice, queue };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  queue?.close();
  queue = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('dialog content', () => {
  it('shows the question, the product name and exactly three buttons', () => {
    const { queue: q } = build();
    q.enqueue({
      jobId: 'job-1',
      productTitle: 'Anker 65W Charger',
      collectionLabel: 'Chargers',
    });

    expect(query('[role="dialog"]')).toBeTruthy();
    expect(query('#pphunt-choice-title')?.textContent).toBe(
      'Where would you like to save this product?',
    );
    expect(query('[data-testid="collection-choice-product"]')?.textContent).toBe(
      'Anker 65W Charger',
    );
    expect(query('[data-action="current"]')?.textContent).toBe('Add to "Chargers"');
    expect(query('[data-action="new"]')?.textContent).toBe('Create new collection');
    expect(query('[data-action="cancel"]')?.textContent).toBe('Cancel');

    const buttons = shadow()?.querySelectorAll('button') ?? [];
    expect(buttons).toHaveLength(3);
    for (const button of Array.from(buttons)) {
      expect(button.type).toBe('button');
    }

    // Buttons only: a text field here would turn a two-click decision into typing.
    expect(shadow()?.querySelector('input')).toBeNull();
    expect(shadow()?.querySelector('form')).toBeNull();
  });

  it('falls back to a neutral label when the page exposed no title', () => {
    const { queue: q } = build();
    q.enqueue({ jobId: 'job-1', collectionLabel: 'Chargers' });

    expect(query('[data-testid="collection-choice-product"]')?.textContent).toBe(
      'This product',
    );
  });

  it('never renders a page-controlled title as markup', () => {
    const { queue: q } = build();
    q.enqueue({
      jobId: 'job-1',
      productTitle: '<img src=x onerror="window.pwned=1">',
      collectionLabel: '<b>Chargers</b>',
    });

    expect(shadow()?.querySelector('img')).toBeNull();
    expect(query('[data-testid="collection-choice-product"]')?.textContent).toBe(
      '<img src=x onerror="window.pwned=1">',
    );
    expect(query('[data-action="current"]')?.querySelector('b')).toBeNull();
  });
});

describe('answers', () => {
  it('choosing "Create new collection" reports the job id and closes', () => {
    const { queue: q, onChoice } = build();
    q.enqueue({ jobId: 'job-new', collectionLabel: 'Chargers' });

    query('[data-action="new"]')?.click();

    expect(onChoice).toHaveBeenCalledWith('job-new', 'new');
    expect(host()).toBeNull();
    expect(q.size()).toBe(0);
  });

  it('choosing "Add to current" reports "current"', () => {
    const { queue: q, onChoice } = build();
    q.enqueue({ jobId: 'job-current', collectionLabel: 'Chargers' });

    query('[data-action="current"]')?.click();

    expect(onChoice).toHaveBeenCalledWith('job-current', 'current');
  });

  it('Escape is Cancel', () => {
    const { queue: q, onChoice } = build();
    q.enqueue({ jobId: 'job-esc', collectionLabel: 'Chargers' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onChoice).toHaveBeenCalledWith('job-esc', 'cancel');
    expect(host()).toBeNull();
  });

  it('a backdrop click is Cancel but a click inside the panel is not', () => {
    const { queue: q, onChoice } = build();
    q.enqueue({ jobId: 'job-backdrop', collectionLabel: 'Chargers' });

    query('[role="dialog"]')?.click();
    expect(onChoice).not.toHaveBeenCalled();

    query('[data-testid="collection-choice-backdrop"]')?.click();
    expect(onChoice).toHaveBeenCalledWith('job-backdrop', 'cancel');
  });

  it('auto-dismisses after 30 s, keeping the current assignment', () => {
    vi.useFakeTimers();
    const { queue: q, onChoice } = build();
    q.enqueue({ jobId: 'job-timeout', collectionLabel: 'Chargers' });

    vi.advanceTimersByTime(COLLECTION_CHOICE_TIMEOUT_MS - 1);
    expect(onChoice).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChoice).toHaveBeenCalledWith('job-timeout', 'cancel');
    expect(host()).toBeNull();
  });

  it('goes back to where the focus was', () => {
    const outside = document.createElement('button');
    outside.textContent = 'page control';
    document.body.appendChild(outside);
    outside.focus();

    const { queue: q } = build();
    q.enqueue({ jobId: 'job-focus', collectionLabel: 'Chargers' });

    expect(shadow()?.activeElement).toBe(query('[data-action="current"]'));

    q.close();
    expect(document.activeElement).toBe(outside);
  });
});

describe('queueing', () => {
  it('shows one dialog at a time with a counter', () => {
    const { queue: q } = build();
    q.enqueue({ jobId: 'job-1', collectionLabel: 'Chargers' });
    q.enqueue({ jobId: 'job-2', collectionLabel: 'Chargers' });

    expect(document.querySelectorAll(`#${COLLECTION_CHOICE_DIALOG_ID}`)).toHaveLength(1);
    expect(query('[data-testid="collection-choice-counter"]')?.textContent).toBe('1 of 2');
    expect(q.size()).toBe(2);

    query('[data-action="new"]')?.click();

    expect(document.querySelectorAll(`#${COLLECTION_CHOICE_DIALOG_ID}`)).toHaveLength(1);
    expect(query('[data-testid="collection-choice-counter"]')?.hidden).toBe(true);
    expect(q.size()).toBe(1);
  });

  it('grows the counter when a save arrives while a dialog is open', () => {
    const { queue: q } = build();
    q.enqueue({ jobId: 'job-1', collectionLabel: 'Chargers' });

    expect(query('[data-testid="collection-choice-counter"]')?.hidden).toBe(true);

    q.enqueue({ jobId: 'job-2', collectionLabel: 'Chargers' });
    expect(query('[data-testid="collection-choice-counter"]')?.textContent).toBe('1 of 2');
  });

  it('ignores a duplicate delivery of the same job', () => {
    const { queue: q, onChoice } = build();
    expect(q.enqueue({ jobId: 'job-dup', collectionLabel: 'A' })).toBe(true);
    expect(q.enqueue({ jobId: 'job-dup', collectionLabel: 'A' })).toBe(false);

    expect(q.size()).toBe(1);
    query('[data-action="current"]')?.click();
    expect(onChoice).toHaveBeenCalledTimes(1);
  });

  it('close() dismisses without reporting a choice', () => {
    const { queue: q, onChoice } = build();
    q.enqueue({ jobId: 'job-close', collectionLabel: 'Chargers' });

    q.close();

    expect(onChoice).not.toHaveBeenCalled();
    expect(host()).toBeNull();
    expect(q.size()).toBe(0);
  });

  it('accepts nothing after close()', () => {
    const { queue: q } = build();
    q.close();

    expect(q.enqueue({ jobId: 'job-late', collectionLabel: 'Chargers' })).toBe(false);
    expect(host()).toBeNull();
  });
});
