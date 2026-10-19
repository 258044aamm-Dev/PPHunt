import { createChurnResistantDebounce } from '../scraper/mutation-debounce';
import { SAVABLE_CARD_SELECTORS } from './save-target';

/**
 * SAD-282 (plan 8.3): keep a cheap, continuous view of the product cards on the
 * page without touching the full-page collection observer.
 *
 * Three rules make it cheap:
 *   1. `childList` + `subtree` only - attribute churn (counters, lazy images,
 *      price tickers) can never schedule a scan.
 *   2. A scan is scheduled only when an added node is, or contains, a card.
 *   3. A `WeakSet` remembers reported cards, so a rescan costs O(new cards).
 *
 * The module never writes to the DOM: the caller (the card button in P2.2) owns
 * its hosts, and `stop()` only disconnects and unsubscribes.
 */

export const CARD_OBSERVER_ROOT_MARGIN = '200px';
export const CARD_OBSERVER_DEBOUNCE_MS = 300;
export const CARD_OBSERVER_MAX_WAIT_MS = 2_000;

export type CardVisibleTrigger = 'visible' | 'immediate';

export interface CardObserverOptions {
  /** Called once per card, when it is worth creating a button for it. */
  onCardVisible: (card: Element, trigger: CardVisibleTrigger) => void;
  /** Called for every card the first time it is discovered, before visibility. */
  onCardAdded?: (card: Element) => void;
  /** Called when the page URL changed between scans; remove stale hosts here. */
  onNavigate?: () => void;
  /** Called from `stop()`, after the observers are disconnected. */
  onTeardown?: () => void;
  doc?: Document;
  win?: Window;
  debounceMs?: number;
  maxWaitMs?: number;
  rootMargin?: string;
  selectors?: readonly string[];
}

export interface CardObserverStats {
  scans: number;
  cards: number;
}

export interface CardObserver {
  start: () => void;
  stop: () => void;
  /** Forces a synchronous scan (used after a known navigation or a retry). */
  rescan: () => void;
  stats: () => CardObserverStats;
}

function currentHref(doc: Document, win: Window | undefined): string {
  try {
    return win?.location?.href ?? doc.location?.href ?? '';
  } catch {
    return '';
  }
}

export function createCardObserver(options: CardObserverOptions): CardObserver {
  const doc = options.doc ?? document;
  const win =
    options.win ??
    (typeof window === 'undefined' ? undefined : window);
  const selector = (options.selectors ?? SAVABLE_CARD_SELECTORS).join(', ');
  const debounceMs = options.debounceMs ?? CARD_OBSERVER_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? CARD_OBSERVER_MAX_WAIT_MS;
  const rootMargin = options.rootMargin ?? CARD_OBSERVER_ROOT_MARGIN;

  let started = false;
  let seen = new WeakSet<Element>();
  let reported = new WeakSet<Element>();
  let mutationObserver: MutationObserver | null = null;
  let intersectionObserver: IntersectionObserver | null = null;
  let scheduler: ReturnType<typeof createChurnResistantDebounce> | null = null;
  let lastHref = '';
  let scans = 0;
  let cards = 0;

  const isCardNode = (node: Element): boolean => {
    try {
      return node.matches(selector) || Boolean(node.querySelector(selector));
    } catch {
      return false;
    }
  };

  const report = (card: Element, trigger: CardVisibleTrigger) => {
    // A late intersection entry after `unobserve` must not create a second button.
    if (reported.has(card)) return;
    reported.add(card);

    try {
      options.onCardVisible(card, trigger);
    } catch (error) {
      console.warn('[PPHunt] card observer callback failed:', error);
    }
  };

  const connectIntersections = () => {
    intersectionObserver?.disconnect();
    intersectionObserver = null;

    const IntersectionObserverCtor = (
      win as unknown as { IntersectionObserver?: typeof IntersectionObserver }
    )?.IntersectionObserver;

    if (typeof IntersectionObserverCtor !== 'function') return;

    intersectionObserver = new IntersectionObserverCtor(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          intersectionObserver?.unobserve(entry.target);
          report(entry.target, 'visible');
        }
      },
      { rootMargin },
    );
  };

  const resetForNavigation = () => {
    lastHref = currentHref(doc, win);
    seen = new WeakSet<Element>();
    reported = new WeakSet<Element>();
    connectIntersections();

    try {
      options.onNavigate?.();
    } catch (error) {
      console.warn('[PPHunt] card observer navigation hook failed:', error);
    }
  };

  const scan = () => {
    if (!started) return;

    if (currentHref(doc, win) !== lastHref) {
      resetForNavigation();
    }

    scans += 1;

    let found: Element[] = [];
    try {
      found = Array.from(doc.querySelectorAll(selector));
    } catch {
      return;
    }

    for (const card of found) {
      if (seen.has(card)) continue;
      seen.add(card);
      cards += 1;

      try {
        options.onCardAdded?.(card);
      } catch (error) {
        console.warn('[PPHunt] card observer add hook failed:', error);
      }

      if (intersectionObserver) {
        intersectionObserver.observe(card);
      } else {
        report(card, 'immediate');
      }
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    lastHref = currentHref(doc, win);

    scheduler = createChurnResistantDebounce(scan, { debounceMs, maxWaitMs });
    connectIntersections();

    const root = doc.body ?? doc.documentElement;
    if (root && typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node.nodeType !== 1) continue;
            if (isCardNode(node as Element)) {
              scheduler?.notify();
              return;
            }
          }
        }
      });
      mutationObserver.observe(root, { childList: true, subtree: true });
    }

    win?.addEventListener('popstate', onLocationEvent);
    win?.addEventListener('hashchange', onLocationEvent);
    win?.addEventListener('pagehide', onPageHide);
    win?.addEventListener('beforeunload', onPageHide);

    scan();
  };

  function onLocationEvent() {
    scheduler?.notify();
  }

  function onPageHide() {
    stop();
  }

  const stop = () => {
    if (!started) return;
    started = false;

    mutationObserver?.disconnect();
    mutationObserver = null;

    intersectionObserver?.disconnect();
    intersectionObserver = null;

    scheduler?.cancel();
    scheduler = null;

    win?.removeEventListener('popstate', onLocationEvent);
    win?.removeEventListener('hashchange', onLocationEvent);
    win?.removeEventListener('pagehide', onPageHide);
    win?.removeEventListener('beforeunload', onPageHide);

    seen = new WeakSet<Element>();
    reported = new WeakSet<Element>();

    try {
      options.onTeardown?.();
    } catch (error) {
      console.warn('[PPHunt] card observer teardown hook failed:', error);
    }
  };

  const rescan = () => {
    if (!started) return;
    scheduler?.cancel();
    scan();
  };

  return {
    start,
    stop,
    rescan,
    stats: () => ({ scans, cards }),
  };
}
