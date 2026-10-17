interface ScrollConfig {
  scrollAmount: number;
  scrollSpeed?: number;
  scrollInterval: number;
  waitAfterScroll: number;
  maxWaitForNew: number;
  maxLoadingWait?: number;
}

const DEFAULT_CONFIG: ScrollConfig = {
  scrollAmount: 800,
  scrollInterval: 500,
  waitAfterScroll: 1500,
  maxWaitForNew: 5000,
  maxLoadingWait: 15000,
};

type Status = 'idle' | 'running' | 'paused' | 'stopped';

/**
 * Auto-scroll controller for "Automatic" collection mode.
 * Scrolls the page, waits for new content (extending wait when loading spinners are active),
 * and reports when end-of-page is reached.
 * Adds ±20% jitter to scroll intervals for human-like behavior.
 */
export class ScrollController {
  private config: ScrollConfig;
  private status: Status = 'idle';
  // DOM timer id (window.setInterval); @types/node would widen ReturnType<typeof setInterval> to Timeout.
  private scrollTimer: number | null = null;
  private staleCount = 0;
  private loadingWaitCount = 0;
  private lastProductCount = 0;
  private tickFn: (() => void) | null = null;

  constructor(config?: Partial<ScrollConfig>) {
    const resolvedAmount =
      config?.scrollAmount ?? config?.scrollSpeed ?? DEFAULT_CONFIG.scrollAmount;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      scrollAmount: resolvedAmount,
    };
  }

  private getJitteredInterval(): number {
    const jitter = this.config.scrollInterval * 0.2;
    return this.config.scrollInterval + (Math.random() * 2 - 1) * jitter;
  }

  /**
   * Start auto-scrolling.
   * @param onNewProducts Called when new products are detected in the DOM
   * @param onEndOfPage Called when no more products appear
   * @param shouldContinue Return false to stop scrolling (e.g. target reached)
   * @param countProducts Return current product count from DOM
   * @param isLoading Optional callback returning true while loading indicators are visible
   */
  start(
    onNewProducts: (count: number) => void,
    onEndOfPage: () => void,
    shouldContinue: () => boolean,
    countProducts: () => number,
    isLoading?: () => boolean
  ): void {
    if (this.status === 'running') return;

    this.status = 'running';
    this.staleCount = 0;
    this.loadingWaitCount = 0;
    this.lastProductCount = countProducts();

    const maxLoadingTicks = Math.ceil(
      (this.config.maxLoadingWait ?? 15000) / this.config.scrollInterval
    );

    const tick = () => {
      if (this.status !== 'running') return;
      if (!shouldContinue()) {
        this.stop();
        return;
      }

      // If a loading indicator is currently active and we haven't exceeded maxLoadingWait,
      // wait for the spinner to finish before scrolling further or incrementing staleCount.
      if (isLoading?.() && this.loadingWaitCount < maxLoadingTicks) {
        this.loadingWaitCount++;
        return;
      }
      this.loadingWaitCount = 0;

      // Scroll
      window.scrollBy({
        top: this.config.scrollAmount,
        behavior: 'smooth',
      });

      // Wait for content to load, then check for new products
      setTimeout(() => {
        if (this.status !== 'running') return;

        const currentCount = countProducts();

        if (currentCount > this.lastProductCount) {
          // New products found
          this.staleCount = 0;
          this.loadingWaitCount = 0;
          this.lastProductCount = currentCount;
          onNewProducts(currentCount);
        } else if (isLoading?.() && this.loadingWaitCount < maxLoadingTicks) {
          // Spinner is still active — extend wait without counting as stale yet
          this.loadingWaitCount++;
          return;
        } else {
          // No new products
          this.staleCount++;
        }

        // Check if end of page
        const maxStale = Math.ceil(
          this.config.maxWaitForNew / this.config.scrollInterval
        );
        if (this.staleCount >= maxStale) {
          this.stop();
          onEndOfPage();
          return;
        }

        // Check if we're at the bottom of the page
        const atBottom =
          window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 10;
        if (atBottom && this.staleCount >= 2 && !isLoading?.()) {
          this.stop();
          onEndOfPage();
          return;
        }
      }, this.config.waitAfterScroll);
    };

    this.tickFn = tick;

    // First tick immediately
    tick();
    this.scrollTimer = window.setInterval(tick, this.getJitteredInterval());
  }

  pause(): void {
    if (this.status === 'running') {
      this.status = 'paused';
      if (this.scrollTimer) {
        clearInterval(this.scrollTimer);
        this.scrollTimer = null;
      }
    }
  }

  resume(): void {
    if (this.status === 'paused' && this.tickFn) {
      this.status = 'running';
      if (this.scrollTimer) {
        clearInterval(this.scrollTimer);
      }
      this.tickFn();
      this.scrollTimer = window.setInterval(
        this.tickFn,
        this.getJitteredInterval()
      );
    }
  }

  stop(): void {
    this.status = 'stopped';
    if (this.scrollTimer) {
      clearInterval(this.scrollTimer);
      this.scrollTimer = null;
    }
  }

  updateConfig(config: Partial<ScrollConfig>): void {
    const resolvedAmount =
      config.scrollAmount ?? config.scrollSpeed ?? this.config.scrollAmount;
    this.config = {
      ...this.config,
      ...config,
      scrollAmount: resolvedAmount,
    };
  }

  get isRunning(): boolean {
    return this.status === 'running';
  }

  get isPaused(): boolean {
    return this.status === 'paused';
  }

  get currentStatus(): Status {
    return this.status;
  }
}
