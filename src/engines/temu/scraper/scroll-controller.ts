import { detectTemuChallengeOrRestriction } from './captcha-detector';
import { countTemuProductCardsOnPage } from './page-detector';
import { TEMU_SELECTORS } from './selectors';

export interface TemuScrollControllerOptions {
  scrollAmount?: number;
  scrollInterval?: number;
  waitAfterScroll?: number;
  maxStaleScrolls?: number;
  countProducts?: () => number;
  onNewProducts: (scrollCount: number) => void;
  onEndOfPage: (scrollCount: number) => void;
  onCaptchaDetected: (reason: string) => void;
  onError: (error: string) => void;
}

/**
 * Controls automatic scrolling and "See more items" pagination on Temu listing pages.
 * Immediately stops if a security verification / CAPTCHA dialog or access restriction appears.
 */
export class TemuScrollController {
  private running = false;
  private paused = false;
  private scrollCount = 0;
  private staleCount = 0;
  private lastProductCount = 0;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private waitTimerId: ReturnType<typeof setTimeout> | null = null;

  private readonly scrollAmount: number;
  private readonly scrollInterval: number;
  private readonly waitAfterScroll: number;
  private readonly maxStaleScrolls: number;
  private readonly countProducts: () => number;
  private readonly onNewProducts: (scrollCount: number) => void;
  private readonly onEndOfPage: (scrollCount: number) => void;
  private readonly onCaptchaDetected: (reason: string) => void;
  private readonly onError: (error: string) => void;

  constructor(options: TemuScrollControllerOptions) {
    this.scrollAmount = options.scrollAmount ?? 800;
    this.scrollInterval = options.scrollInterval ?? 1500;
    this.waitAfterScroll = options.waitAfterScroll ?? 2000;
    this.maxStaleScrolls = options.maxStaleScrolls ?? 5;
    this.countProducts =
      options.countProducts ?? (() => countTemuProductCardsOnPage(document));
    this.onNewProducts = options.onNewProducts;
    this.onEndOfPage = options.onEndOfPage;
    this.onCaptchaDetected = options.onCaptchaDetected;
    this.onError = options.onError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.scrollCount = 0;
    this.staleCount = 0;
    this.lastProductCount = this.countProducts();
    this.scheduleNextScroll();
  }

  pause(): void {
    this.paused = true;
    this.clearTimers();
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.scheduleNextScroll();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.clearTimers();
  }

  get isRunning(): boolean {
    return this.running && !this.paused;
  }

  get currentScrollCount(): number {
    return this.scrollCount;
  }

  private clearTimers(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.waitTimerId !== null) {
      clearTimeout(this.waitTimerId);
      this.waitTimerId = null;
    }
  }

  private scheduleNextScroll(): void {
    if (!this.running || this.paused) return;
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.performScroll();
    }, this.scrollInterval);
  }

  private performScroll(): void {
    if (!this.running || this.paused) return;

    try {
      // 1. Check for CAPTCHA / security verification or access restrictions first
      const restriction = detectTemuChallengeOrRestriction(document);
      if (restriction.restricted) {
        this.pause();
        this.onCaptchaDetected(
          restriction.reason ??
            'Temu security verification or access restriction detected.'
        );
        return;
      }

      // 2. If a visible "See more items" button exists in the listing, click it to load the next batch
      const clickedSeeMore = this.tryClickSeeMoreItemsButton();

      // 3. Smoothly scroll down
      window.scrollBy({ top: this.scrollAmount, behavior: 'smooth' });
      this.scrollCount++;

      // 4. Wait for lazy-loaded cards to hydrate
      this.waitTimerId = setTimeout(() => {
        this.waitTimerId = null;
        if (!this.running || this.paused) return;

        const postRestriction = detectTemuChallengeOrRestriction(document);
        if (postRestriction.restricted) {
          this.pause();
          this.onCaptchaDetected(
            postRestriction.reason ??
              'Temu security verification or access restriction detected.'
          );
          return;
        }

        const currentCount = this.countProducts();
        if (currentCount > this.lastProductCount) {
          this.lastProductCount = currentCount;
          this.staleCount = 0;
          this.onNewProducts(this.scrollCount);
        } else {
          this.staleCount++;
        }

        const atBottom =
          window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 200;
        const hasEndOfListBanner = this.detectNoMoreResultsBanner();

        if (
          this.staleCount >= this.maxStaleScrolls ||
          (hasEndOfListBanner && this.staleCount >= 1) ||
          (atBottom && !clickedSeeMore && this.staleCount >= 2)
        ) {
          this.stop();
          this.onEndOfPage(this.scrollCount);
          return;
        }

        this.scheduleNextScroll();
      }, this.waitAfterScroll);
    } catch (err) {
      this.stop();
      this.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Finds and clicks Temu's "See more items" button when visible and enabled.
   */
  private tryClickSeeMoreItemsButton(): boolean {
    const explicitButtons = Array.from(
      document.querySelectorAll<HTMLElement>(
        TEMU_SELECTORS.listing.seeMoreButton
      )
    );

    for (const btn of explicitButtons) {
      if (this.isClickableButton(btn)) {
        btn.click();
        return true;
      }
    }

    const roleButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[role="button"], button')
    );
    for (const btn of roleButtons) {
      const text = (btn.getAttribute('aria-label') ?? btn.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (/^See\s+more(?:\s+items)?$/i.test(text) && this.isClickableButton(btn)) {
        btn.click();
        return true;
      }
    }

    return false;
  }

  private isClickableButton(el: HTMLElement): boolean {
    if (
      el.hidden ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('aria-hidden') === 'true' ||
      (el as HTMLButtonElement).disabled
    ) {
      return false;
    }
    const style = el.style;
    if (
      style &&
      (style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0')
    ) {
      return false;
    }
    return true;
  }

  private detectNoMoreResultsBanner(): boolean {
    const scope =
      document.querySelector(
        '.js-search-goodsList, .js-category-goodsList, [role="main"]'
      ) ?? document.body;
    if (!scope) return false;
    const text = (scope.textContent ?? '').slice(-1500);
    return /\b(?:No\s+more\s+results|No\s+more\s+items)\b/i.test(text);
  }
}
