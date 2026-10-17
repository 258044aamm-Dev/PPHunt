import { AMAZON_SELECTORS, safeQuerySelector } from './selectors';

export interface ScrollControllerConfig {
  scrollAmount: number;
  scrollInterval: number;
  waitAfterScroll: number;
  maxWaitForNew: number;
  maxLoadingWait: number;
}

export const DEFAULT_SCROLL_CONTROLLER_CONFIG: ScrollControllerConfig = {
  scrollAmount: 800,
  scrollInterval: 500,
  waitAfterScroll: 1500,
  maxWaitForNew: 5000,
  maxLoadingWait: 15000,
};

/**
 * Future-proof Hybrid Lazy-Scroll + Load-More / Pagination Controller (`AmazonScrollController`).
 * Smoothly scrolls lazy-hydrated Amazon listings, monitors scoped product card counts
 * (immune to peripheral carousel churn), and triggers safe inline "See more" / "View more deals"
 * controls when approaching the bottom of expandable listings.
 */
export class AmazonScrollController {
  private readonly config: ScrollControllerConfig;
  public isRunning = false;
  public isPaused = false;

  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<ScrollControllerConfig> = {}) {
    this.config = {
      ...DEFAULT_SCROLL_CONTROLLER_CONFIG,
      ...config,
    };
  }

  public start(
    onNewProducts: () => void,
    onEndOfPage: () => void,
    shouldContinue: () => boolean,
    getProductCount: () => number,
    isLoading: () => boolean = () => false,
  ): void {
    this.stop();
    this.isRunning = true;
    this.isPaused = false;

    let lastProductCount = getProductCount();
    let staleTicks = 0;
    let loadingWaitElapsed = 0;

    const maxStaleTicks = Math.max(
      1,
      Math.ceil(this.config.maxWaitForNew / Math.max(1, this.config.scrollInterval)),
    );

    const scheduleNextTick = () => {
      if (!this.isRunning) return;
      this.intervalTimer = setTimeout(runTick, this.config.scrollInterval);
    };

    const runTick = () => {
      if (!this.isRunning) return;
      if (this.isPaused) {
        scheduleNextTick();
        return;
      }
      if (!shouldContinue()) {
        this.stop();
        return;
      }

      if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
        try {
          window.scrollBy({
            top: this.config.scrollAmount,
            behavior: 'smooth',
          });
        } catch {
          // Ignore unimplemented window.scrollBy in headless test environments
        }
      }

      this.waitTimer = setTimeout(() => {
        if (!this.isRunning) return;
        if (this.isPaused) {
          scheduleNextTick();
          return;
        }
        if (!shouldContinue()) {
          this.stop();
          return;
        }

        if (isLoading() && loadingWaitElapsed < this.config.maxLoadingWait) {
          loadingWaitElapsed +=
            this.config.scrollInterval + this.config.waitAfterScroll;
          scheduleNextTick();
          return;
        }
        loadingWaitElapsed = 0;

        const currentCount = getProductCount();
        if (currentCount > lastProductCount) {
          lastProductCount = currentCount;
          staleTicks = 0;
          onNewProducts();
          if (!this.isRunning || !shouldContinue()) {
            this.stop();
            return;
          }
          scheduleNextTick();
          return;
        }

        staleTicks += 1;

        // Hybrid Load-More / Inline Expansion attempt before declaring end-of-page
        if (staleTicks === Math.max(1, maxStaleTicks - 2)) {
          this.tryTriggerLoadMore();
        }

        if (staleTicks >= maxStaleTicks) {
          this.stop();
          onEndOfPage();
          return;
        }

        scheduleNextTick();
      }, this.config.waitAfterScroll);
    };

    scheduleNextTick();
  }

  /**
   * Attempts to trigger safe inline "See more" / "View more deals" / load-more buttons
   * when viewport scrolling reaches the end of currently hydrated cards.
   */
  public tryTriggerLoadMore(doc?: Document | null): boolean {
    const activeDoc =
      doc ?? (typeof document !== 'undefined' ? document : null);
    if (!activeDoc) return false;

    for (const selector of AMAZON_SELECTORS.category.loadMoreControls) {
      // Avoid navigating away on full page anchor links unless it's an inline button
      if (selector.startsWith('a.')) continue;
      const control = safeQuerySelector<HTMLElement>(activeDoc, selector);
      if (
        control &&
        !control.hasAttribute('disabled') &&
        control.getAttribute('aria-disabled') !== 'true'
      ) {
        try {
          control.click();
          return true;
        } catch {
          // Ignore click errors
        }
      }
    }

    const buttons = Array.from(activeDoc.querySelectorAll<HTMLElement>('button'));
    for (const btn of buttons) {
      if (
        btn.hasAttribute('disabled') ||
        btn.getAttribute('aria-disabled') === 'true'
      ) {
        continue;
      }
      const label = (
        btn.getAttribute('aria-label') ||
        btn.textContent ||
        ''
      ).trim();
      if (/^(?:see|load|view|show)\s+more\b/i.test(label)) {
        try {
          btn.click();
          return true;
        } catch {
          // Ignore click errors
        }
      }
    }
    return false;
  }

  public pause(): void {
    if (!this.isRunning) return;
    this.isPaused = true;
  }

  public resume(): void {
    if (!this.isRunning) return;
    this.isPaused = false;
  }

  public stop(): void {
    this.isRunning = false;
    this.isPaused = false;
    if (this.intervalTimer !== null) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.waitTimer !== null) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }
}

export const ScrollController = AmazonScrollController;
export type ScrollController = AmazonScrollController;

