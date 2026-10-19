/**
 * SAD-283 (P2.2) - the per-card save control.
 *
 * Two things matter here: the control must never trigger the card's own link or
 * cart, and it must be honest about state (six states, partial enrichment, retry)
 * while staying reachable and labelled for assistive technology.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARD_ACTION_COMPLETED_RESET_MS,
  CARD_ACTION_HOST_ATTRIBUTE,
  createCardActionButton,
  mountCardActionButton,
  resolveCardActionMountPoint,
  unmountAllCardActionButtons,
  type CardActionButtonHandle,
} from '@/engines/amazon/content/card-action-button';

const CARD_HTML = `
  <div data-component-type="s-search-result" data-asin="B0AAAAAAAA" id="card">
    <div data-component-type="s-product-image" id="image-tile">
      <img id="image" src="https://m.media-amazon.com/images/I/a.jpg">
    </div>
    <h2><a id="title-link" href="/Test-A/dp/B0AAAAAAAA"><span>Anker 65W Charger</span></a></h2>
    <span class="a-price"><span class="a-price-whole">19</span></span>
  </div>
`;

let handle: CardActionButtonHandle | null = null;

function card(): Element {
  const element = document.getElementById('card');
  if (!element) throw new Error('fixture card is missing');
  return element;
}

function button(): HTMLButtonElement {
  if (!handle) throw new Error('no handle');
  return handle.button;
}

beforeEach(() => {
  document.body.innerHTML = CARD_HTML;
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  unmountAllCardActionButtons();
  vi.useRealTimers();
});

describe('rendering', () => {
  it('mounts one host with a closed shadow root and no page-visible shadow', () => {
    handle = createCardActionButton({
      asin: 'B0AAAAAAAA',
      title: 'Anker 65W Charger',
      onActivate: vi.fn(),
    });
    document.body.appendChild(handle.host);

    expect(handle.host.getAttribute(CARD_ACTION_HOST_ATTRIBUTE)).toBe('');
    expect(handle.host.getAttribute('data-asin')).toBe('B0AAAAAAAA');
    expect(handle.host.getAttribute('draggable')).toBe('false');
    expect(handle.host.style.position).toBe('absolute');
    expect(handle.host.shadowRoot).toBeNull();
    expect(handle.shadowRoot.querySelector('button')).toBe(handle.button);
  });

  it('starts idle, labelled with the product title', () => {
    handle = createCardActionButton({
      asin: 'B0AAAAAAAA',
      title: 'Anker 65W Charger',
      onActivate: vi.fn(),
    });

    expect(handle.getState()).toBe('idle');
    expect(button().dataset.state).toBe('idle');
    expect(button().getAttribute('aria-label')).toBe(
      'Save product details: Anker 65W Charger',
    );
    expect(button().type).toBe('button');
    expect(button().hasAttribute('aria-busy')).toBe(false);
  });

  it('renders all six states with busy and live-region semantics', () => {
    handle = createCardActionButton({
      asin: 'B0AAAAAAAA',
      title: 'Anker 65W Charger',
      onActivate: vi.fn(),
      completedResetMs: 0,
    });

    const live = handle.shadowRoot.querySelector('[aria-live="polite"]');

    handle.setState('queued');
    expect(button().dataset.state).toBe('queued');
    expect(button().getAttribute('aria-busy')).toBe('true');

    handle.setState('extracting');
    expect(button().dataset.state).toBe('extracting');
    expect(live?.textContent).toContain('Saving product');

    handle.setState('enriching');
    expect(button().dataset.state).toBe('enriching');
    expect(live?.textContent).toContain('Fetching product details');

    handle.setState('completed');
    expect(button().dataset.state).toBe('completed');
    expect(button().hasAttribute('aria-busy')).toBe(false);
    expect(live?.textContent).toBe('Saved');

    handle.setState('failed', { reason: 'network' });
    expect(button().dataset.state).toBe('failed');
    expect(button().getAttribute('aria-label')).toContain('Retry saving');
    expect(button().getAttribute('title')).toContain('network');
    expect(handle.host.hasAttribute('data-partial')).toBe(false);
  });

  it('flags partial enrichment without turning it into a failure', () => {
    handle = createCardActionButton({
      asin: 'B0AAAAAAAA',
      title: 'Anker 65W Charger',
      onActivate: vi.fn(),
      completedResetMs: 0,
    });

    handle.setState('completed', { partial: true });

    expect(handle.getState()).toBe('completed');
    expect(handle.host.getAttribute('data-partial')).toBe('true');
    expect(button().getAttribute('title')).toBe('Saved — details unavailable');
    expect(button().getAttribute('aria-label')).toBe(
      'Saved — details unavailable: Anker 65W Charger',
    );
  });

  it('auto-reverts completed to idle, and destroy cancels the timer', () => {
    vi.useFakeTimers();
    handle = createCardActionButton({
      asin: 'B0AAAAAAAA',
      title: 'Anker',
      onActivate: vi.fn(),
    });

    handle.setState('completed');
    vi.advanceTimersByTime(CARD_ACTION_COMPLETED_RESET_MS - 1);
    expect(handle.getState()).toBe('completed');

    vi.advanceTimersByTime(1);
    expect(handle.getState()).toBe('idle');

    handle.setState('completed');
    handle.destroy();
    vi.advanceTimersByTime(CARD_ACTION_COMPLETED_RESET_MS * 2);
    expect(handle.getState()).toBe('completed');
  });
});

describe('click safety', () => {
  it('activates once from idle and shows a queued state immediately', () => {
    const onActivate = vi.fn();
    handle = createCardActionButton({ asin: 'B0AAAAAAAA', onActivate });

    button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith({ asin: 'B0AAAAAAAA', retry: false });
    expect(handle.getState()).toBe('queued');
  });

  it('never starts a second job while one is running', () => {
    vi.useFakeTimers();
    const onActivate = vi.fn();
    handle = createCardActionButton({ asin: 'B0AAAAAAAA', onActivate });

    handle.setState('extracting');
    button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onActivate).not.toHaveBeenCalled();
    expect(handle.host.getAttribute('data-pulse')).toBe('true');

    vi.advanceTimersByTime(500);
    expect(handle.host.hasAttribute('data-pulse')).toBe(false);
  });

  it('turns a failed click into a retry', () => {
    const onActivate = vi.fn();
    handle = createCardActionButton({ asin: 'B0AAAAAAAA', onActivate });

    handle.setState('failed', { reason: 'network' });
    button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onActivate).toHaveBeenCalledWith({ asin: 'B0AAAAAAAA', retry: true });
  });

  it('prevents the default action and stops pointer events reaching the card', () => {
    const onActivate = vi.fn();
    handle = createCardActionButton({ asin: 'B0AAAAAAAA', onActivate });
    card().appendChild(handle.host);

    const cardListener = vi.fn();
    card().addEventListener('click', cardListener);
    card().addEventListener('pointerdown', cardListener);
    card().addEventListener('mousedown', cardListener);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    button().dispatchEvent(click);
    button().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    button().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(click.defaultPrevented).toBe(true);
    expect(cardListener).not.toHaveBeenCalled();
  });

  it('contains activation errors instead of leaving the button stuck', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    handle = createCardActionButton({
      asin: 'B0AAAAAAAA',
      onActivate: () => {
        throw new Error('pipeline exploded');
      },
    });

    button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(handle.getState()).toBe('failed');
    warn.mockRestore();
  });
});

describe('mounting', () => {
  it('mounts on the image tile, never inside the title link', () => {
    handle = mountCardActionButton(card(), { onActivate: vi.fn() });

    expect(handle).not.toBeNull();
    expect(handle?.host.parentElement?.id).toBe('image-tile');
    expect(handle?.host.closest('a')).toBeNull();
  });

  it('falls back to the card when the image sits inside a link', () => {
    document.body.innerHTML = `
      <div data-component-type="s-search-result" data-asin="B0BBBBBBBB" id="card-linked">
        <a href="/dp/B0BBBBBBBB"><img id="linked-image" src="https://m.media-amazon.com/images/I/b.jpg"></a>
      </div>
    `;
    const linkedCard = document.getElementById('card-linked') as Element;

    expect(resolveCardActionMountPoint(linkedCard)).toBe(linkedCard);
  });

  it('mounts one control per card even when asked twice', () => {
    const first = mountCardActionButton(card(), { onActivate: vi.fn() });
    const second = mountCardActionButton(card(), { onActivate: vi.fn() });

    expect(second).toBe(first);
    expect(card().querySelectorAll(`[${CARD_ACTION_HOST_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it('makes a static mount point relative and restores it exactly', () => {
    const tile = document.getElementById('image-tile') as HTMLElement;
    expect(tile.style.position).toBe('');

    const mounted = mountCardActionButton(card(), { onActivate: vi.fn() });
    expect(tile.style.position).toBe('relative');

    mounted?.destroy();
    expect(tile.style.position).toBe('');
    expect(card().querySelectorAll(`[${CARD_ACTION_HOST_ATTRIBUTE}]`)).toHaveLength(0);
  });

  it('leaves an already positioned mount point alone', () => {
    const tile = document.getElementById('image-tile') as HTMLElement;
    tile.style.position = 'absolute';

    const mounted = mountCardActionButton(card(), { onActivate: vi.fn() });
    expect(tile.style.position).toBe('absolute');

    mounted?.destroy();
    expect(tile.style.position).toBe('absolute');
  });

  it('refuses a card without an ASIN', () => {
    const anon = document.createElement('div');
    anon.innerHTML = '<img src="https://m.media-amazon.com/images/I/c.jpg">';
    document.body.appendChild(anon);

    expect(mountCardActionButton(anon, { onActivate: vi.fn() })).toBeNull();
  });

  it('unmounts everything and restores every inline position', () => {
    document.body.innerHTML = `
      <div data-asin="B0AAAAAAAA" id="card-a">
        <div data-component-type="s-product-image" id="tile-a"></div>
      </div>
      <div data-asin="B0BBBBBBBB" id="card-b">
        <div data-component-type="s-product-image" id="tile-b"></div>
      </div>
    `;

    mountCardActionButton(document.getElementById('card-a') as Element, {
      onActivate: vi.fn(),
    });
    mountCardActionButton(document.getElementById('card-b') as Element, {
      onActivate: vi.fn(),
    });

    expect(document.querySelectorAll(`[${CARD_ACTION_HOST_ATTRIBUTE}]`)).toHaveLength(2);

    unmountAllCardActionButtons();

    expect(document.querySelectorAll(`[${CARD_ACTION_HOST_ATTRIBUTE}]`)).toHaveLength(0);
    expect((document.getElementById('tile-a') as HTMLElement).style.position).toBe('');
    expect((document.getElementById('tile-b') as HTMLElement).style.position).toBe('');
  });
});

describe('theme and accessibility contract', () => {
  it('switches theme through the host attribute', () => {
    handle = createCardActionButton({
      asin: 'B0AAAAAAAA',
      theme: 'light',
      onActivate: vi.fn(),
    });
    expect(handle.host.getAttribute('data-theme')).toBe('light');

    handle.setTheme('dark');
    expect(handle.host.getAttribute('data-theme')).toBe('dark');

    handle.setTheme('auto');
    expect(handle.host.getAttribute('data-theme')).toBe('auto');
  });

  it('ships tokens for both palettes, a focus ring and a reduced-motion path', () => {
    handle = createCardActionButton({ asin: 'B0AAAAAAAA', onActivate: vi.fn() });
    const css = handle.shadowRoot.querySelector('style')?.textContent ?? '';

    expect(css).toContain('--pph-clay: #b04e30');
    expect(css).toContain('--pph-clay: #d97757');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('border-radius: 0 0 8px 8px');
  });

  it('keeps a 28px native button target reachable by keyboard', () => {
    handle = createCardActionButton({ asin: 'B0AAAAAAAA', onActivate: vi.fn() });
    const style = handle.shadowRoot.querySelector('style')?.textContent ?? '';

    expect(style).toContain('width: 28px');
    expect(style).toContain('height: 28px');
    expect(button().tabIndex).toBe(0);
    expect(button().hasAttribute('disabled')).toBe(false);
  });
});
