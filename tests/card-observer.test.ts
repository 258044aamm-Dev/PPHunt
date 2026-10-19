/**
 * SAD-282 (P2.1) - the card observer that will host the per-card button.
 *
 * The point of these tests is cost: unrelated DOM churn must not schedule work,
 * a rescan must only look at new cards, and teardown must leave the page exactly
 * as it was found (this module never writes to the DOM at all).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARD_OBSERVER_DEBOUNCE_MS,
  createCardObserver,
  type CardObserver,
} from '@/engines/amazon/content/card-observer';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  observed: Element[] = [];
  unobserved: Element[] = [];
  disconnected = false;

  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(target: Element): void {
    this.unobserved.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(targets: Element[]): void {
    const entries = targets.map(
      (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

function cardHtml(asin: string): string {
  return `
    <div data-component-type="s-search-result" data-asin="${asin}">
      <a href="/dp/${asin}"><h2>Product ${asin}</h2></a>
      <span class="a-price"><span class="a-price-whole">19</span></span>
    </div>
  `;
}

function searchPage(count: number): string {
  const cards = Array.from({ length: count }, (_, index) =>
    cardHtml(`B0${String(index).padStart(8, '0')}`),
  ).join('');
  return `<div class="s-main-slot">${cards}</div>`;
}

function visible(calls: Array<[Element, string]>): string[] {
  return calls.map(([card, trigger]) => `${card.getAttribute('data-asin')}:${trigger}`);
}

const originalSetTimeout = globalThis.setTimeout;

/** Waits for jsdom to deliver queued MutationObserver records. */
const flushMutations = () =>
  new Promise<void>((resolve) => {
    originalSetTimeout(resolve, 0);
  });

let observer: CardObserver | null = null;
const calls: Array<[Element, string]> = [];

function makeObserver(overrides: Record<string, unknown> = {}): CardObserver {
  observer = createCardObserver({
    onCardVisible: (card, trigger) => calls.push([card, trigger]),
    ...overrides,
  });
  return observer;
}

afterEach(() => {
  observer?.stop();
  observer = null;
  calls.length = 0;
  FakeIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('discovery', () => {
  it('reports every card present when it starts, exactly once', () => {
    document.body.innerHTML = searchPage(60);

    makeObserver().start();

    expect(calls).toHaveLength(60);
    expect(new Set(calls.map(([card]) => card)).size).toBe(60);
    expect(calls.every(([, trigger]) => trigger === 'immediate')).toBe(true);
  });

  it('reports nothing on a page without cards', () => {
    document.body.innerHTML = '<div id="navFooter">Nothing to save</div>';

    const cardObserver = makeObserver();
    cardObserver.start();

    expect(calls).toHaveLength(0);
    expect(cardObserver.stats()).toEqual({ scans: 1, cards: 0 });
  });
});

describe('churn resistance', () => {
  it('ignores 200 rapid unrelated mutations and scans once when a card arrives', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = searchPage(2);

    const cardObserver = makeObserver();
    cardObserver.start();
    expect(cardObserver.stats().scans).toBe(1);

    const slot = document.querySelector('.s-main-slot') as Element;
    for (let index = 0; index < 200; index += 1) {
      const noise = document.createElement('div');
      noise.className = 'unrelated-widget';
      noise.textContent = String(index);
      slot.appendChild(noise);
    }

    await flushMutations();
    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS * 4);
    expect(cardObserver.stats().scans).toBe(1);

    slot.insertAdjacentHTML('beforeend', cardHtml('B0NEWCARD1'));
    await flushMutations();
    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS);

    expect(cardObserver.stats()).toEqual({ scans: 2, cards: 3 });
    expect(visible(calls)).toContain('B0NEWCARD1:immediate');
  });

  it('does not scan when only attributes change (prices, counters, lazy images)', () => {
    vi.useFakeTimers();
    document.body.innerHTML = searchPage(1);

    const cardObserver = makeObserver();
    cardObserver.start();

    const card = document.querySelector('[data-asin]') as Element;
    const price = document.querySelector('.a-price-whole') as Element;
    price.textContent = '24';
    card.setAttribute('data-index', '7');
    (document.querySelector('h2') as Element).className = 'a-size-base-plus';

    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS * 4);

    expect(cardObserver.stats().scans).toBe(1);
  });

  it('does not scan when a non-card child is appended inside a card', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = searchPage(1);

    const cardObserver = makeObserver();
    cardObserver.start();

    const badge = document.createElement('span');
    badge.className = 'deal-badge';
    badge.textContent = 'Limited time';
    (document.querySelector('[data-asin]') as Element).appendChild(badge);
    await flushMutations();

    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS * 4);

    expect(cardObserver.stats().scans).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('handles an infinite-scroll batch without re-reporting known cards', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = searchPage(10);

    const cardObserver = makeObserver();
    cardObserver.start();
    expect(calls).toHaveLength(10);

    const slot = document.querySelector('.s-main-slot') as Element;
    const batch = Array.from({ length: 20 }, (_, index) =>
      cardHtml(`B0BATCH${String(index).padStart(3, '0')}`),
    ).join('');
    slot.insertAdjacentHTML('beforeend', batch);
    await flushMutations();

    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS);

    expect(calls).toHaveLength(30);
    expect(new Set(calls.map(([card]) => card)).size).toBe(30);
    expect(cardObserver.stats()).toEqual({ scans: 2, cards: 30 });
  });
});

describe('intersection gating', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });

  it('waits for visibility before reporting, then stops watching', () => {
    document.body.innerHTML = searchPage(3);

    const cardObserver = makeObserver({ rootMargin: '200px' });
    cardObserver.start();

    const io = FakeIntersectionObserver.instances[0];
    expect(io?.options?.rootMargin).toBe('200px');
    expect(io?.observed).toHaveLength(3);
    expect(calls).toHaveLength(0);

    const cards = Array.from(document.querySelectorAll('[data-asin]'));
    io?.trigger([cards[0] as Element]);
    expect(visible(calls)).toEqual(['B000000000:visible']);
    expect(io?.unobserved).toHaveLength(1);

    // A late duplicate entry must not create a second button.
    io?.trigger([cards[0] as Element]);
    expect(calls).toHaveLength(1);
  });

  it('falls back to reporting immediately when IntersectionObserver is missing', () => {
    vi.unstubAllGlobals();
    document.body.innerHTML = searchPage(2);

    makeObserver().start();

    expect(calls).toHaveLength(2);
    expect(calls.every(([, trigger]) => trigger === 'immediate')).toBe(true);
  });
});

describe('navigation', () => {
  const originalEntries = 1;

  function goTo(url: string): void {
    window.history.pushState({}, '', url);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('resets on a URL change between scans and re-reports the new page', () => {
    document.body.innerHTML = searchPage(2);
    const onNavigate = vi.fn();
    const cardObserver = makeObserver({ onNavigate });
    cardObserver.start();
    expect(calls).toHaveLength(2);

    goTo('/s?k=next-page');
    document.body.innerHTML = searchPage(3);
    cardObserver.rescan();

    expect(onNavigate).toHaveBeenCalledTimes(1);
    // New page, new cards: all three are reported again.
    expect(callerAsins().slice(-3)).toEqual([
      'B000000000',
      'B000000001',
      'B000000002',
    ]);
    expect(cardObserver.stats().cards).toBe(5);
  });

  it('keeps the reported set when the URL did not change', () => {
    document.body.innerHTML = searchPage(2);
    const cardObserver = makeObserver();
    cardObserver.start();

    cardObserver.rescan();

    expect(calls).toHaveLength(2);
    expect(originalEntries).toBe(1);
  });

  function callerAsins(): string[] {
    return calls.map(([card]) => card.getAttribute('data-asin') ?? '');
  }
});

describe('lifecycle', () => {
  it('start is idempotent: one observer set, one report per card', async () => {
    vi.useFakeTimers();
    const RealMutationObserver = globalThis.MutationObserver;
    let instances = 0;

    class CountingMutationObserver extends RealMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        instances += 1;
      }
    }
    vi.stubGlobal('MutationObserver', CountingMutationObserver);

    document.body.innerHTML = searchPage(2);
    const cardObserver = makeObserver();
    cardObserver.start();
    cardObserver.start();

    expect(instances).toBe(1);

    const slot = document.querySelector('.s-main-slot') as Element;
    slot.insertAdjacentHTML('beforeend', cardHtml('B0LATECARD'));
    await flushMutations();
    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS);

    expect(calls.filter(([card]) => card.getAttribute('data-asin') === 'B0LATECARD')).toHaveLength(1);
  });

  it('stop disconnects, cancels pending work and removes its listeners', () => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    document.body.innerHTML = searchPage(2);

    const onTeardown = vi.fn();
    const cardObserver = makeObserver({ onTeardown });
    cardObserver.start();

    const io = FakeIntersectionObserver.instances[0];
    const slot = document.querySelector('.s-main-slot') as Element;
    slot.insertAdjacentHTML('beforeend', cardHtml('B0PENDING1'));

    cardObserver.stop();

    expect(onTeardown).toHaveBeenCalledTimes(1);
    expect(io?.disconnected).toBe(true);

    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS * 4);
    expect(cardObserver.stats().scans).toBe(1);

    window.dispatchEvent(new Event('popstate'));
    vi.advanceTimersByTime(CARD_OBSERVER_DEBOUNCE_MS * 4);
    expect(cardObserver.stats().scans).toBe(1);

    cardObserver.stop();
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('stops itself on pagehide', () => {
    document.body.innerHTML = searchPage(2);
    const onTeardown = vi.fn();
    const cardObserver = makeObserver({ onTeardown });
    cardObserver.start();

    window.dispatchEvent(new Event('pagehide'));

    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('leaves the DOM byte-identical across start and stop', () => {
    document.body.innerHTML = searchPage(3);
    const before = document.documentElement.outerHTML;

    const cardObserver = makeObserver();
    cardObserver.start();
    cardObserver.stop();

    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('survives a throwing callback without losing the observer', () => {
    document.body.innerHTML = searchPage(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    observer = createCardObserver({
      onCardVisible: () => {
        throw new Error('button factory exploded');
      },
    });
    observer.start();

    expect(warn).toHaveBeenCalled();
    expect(observer.stats().cards).toBe(1);
    warn.mockRestore();
  });
});
