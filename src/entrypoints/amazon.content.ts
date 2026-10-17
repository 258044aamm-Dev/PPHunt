import { detectPageType } from '@/lib/scraper/page-detector';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { parseProductDetail } from '@/lib/scraper/product-detail';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import { SELECTORS } from '@/lib/scraper/selectors';
import { DeduplicationEngine } from '@/lib/scraper/dedup';
import { ScrollController } from '@/lib/scraper/scroll-controller';
import { ParseCache } from '@/lib/scraper/parse-cache';
import { countProductCards } from '@/lib/scraper/count-products';
import {
  createChurnResistantDebounce,
  type ChurnResistantDebounce,
} from '@/lib/scraper/mutation-debounce';
import {
  detectPageIssues,
  hasActiveLoadingIndicator,
} from '@/lib/scraper/captcha-detector';
import type { ScrapedProduct } from '@/types/common';
import {
  validateExtensionMessage,
  type Message,
  type ScrollConfig,
} from '@/lib/schemas';

export default defineContentScript({
  matches: [
    '*://*.amazon.com/*',
    '*://*.amazon.co.uk/*',
    '*://*.amazon.de/*',
    '*://*.amazon.fr/*',
    '*://*.amazon.ca/*',
    '*://*.amazon.co.jp/*',
    '*://*.amazon.in/*',
    '*://*.amazon.com.au/*',
    '*://*.amazon.es/*',
    '*://*.amazon.it/*',
  ],
  runAt: 'document_idle',

  main() {
    const win = window as unknown as {
      __PPHUNT_CONTENT_CLEANUP__?: () => void;
    };
    if (typeof win.__PPHUNT_CONTENT_CLEANUP__ === 'function') {
      try {
        win.__PPHUNT_CONTENT_CLEANUP__();
      } catch {
        // Ignore cleanup errors from prior content-script instance
      }
    }

    console.log('[PPHunt] Content script loaded on:', window.location.href);

    // State
    const dedup = new DeduplicationEngine();
    // H-9a (SAD-177): per-card parse memoisation, owned by the content script
    // and cleared whenever a new run starts (WeakMap self-prunes otherwise).
    const parseCache = new ParseCache();
    // H-1b (SAD-170): set per COLLECT_PRODUCTS from the scroll settings;
    // consulted at the dedup sites below (gate at consultation, not
    // construction, so toggling never needs reconstructed state).
    let dedupEnabled = true;
    let activeScrollCfg: ScrollConfig | undefined;
    // M-1 (SAD-175): ASINs pre-seeded from the DB for this run; counted in
    // the reported total so the counter never regresses after a reload.
    let preSeededCount = 0;
    let scrollController: ScrollController | null = null;
    const collectedProducts: ScrapedProduct[] = [];
    let targetCount = 0;
    let mode: 'manual' | 'automatic' = 'manual';
    let observer: MutationObserver | null = null;
    // H-9b (Phase 5): element the MutationObserver watches + churn-capped debounce
    let observedTarget: Element | null = null;
    let parseDebounce: ChurnResistantDebounce | null = null;

    // Detect initial page type
    const initialPageType = detectPageType(window.location.href, document);
    console.log('[PPHunt] Page type:', initialPageType);

    /**
     * Checks for CAPTCHA, sign-in, or block pages.
     * If detected, pauses active collection without losing collectedProducts and reports CONTENT_ERROR.
     */
    function checkAndHandlePageIssue(): boolean {
      const pageIssue = detectPageIssues(document);
      if (!pageIssue) return false;

      console.warn('[PPHunt] Page issue:', pageIssue.code, pageIssue.message);
      scrollController?.pause();
      stopObserver();
      sendMessage({
        type: 'CONTENT_ERROR',
        payload: {
          code: pageIssue.code,
          message: pageIssue.message,
          diagnostic: (pageIssue as any).diagnostic,
        } as any,
      });
      return true;
    }

    // MutationObserver for manual mode — detects new products as user scrolls.
    // H-9b (Phase 5): watches the results grid (falling back to <body> on
    // unrecognised layouts) instead of the whole document, so unrelated page
    // churn (lazy images, carousels, ad beacons, hover popovers) no longer
    // re-triggers parses. The debounce caps total wait at 2 s, so continuous
    // churn can no longer starve collection, and mutations while the tab is
    // hidden are ignored.
    function resolveResultsContainer(): Element {
      return (
        document.querySelector(SELECTORS.search.resultsContainer) ??
        document.querySelector(SELECTORS.category.resultsContainer) ??
        document.body
      );
    }

    function startObserver(): void {
      // An observer whose target was detached by an SPA container swap is dead —
      // disconnect it and re-resolve the results container.
      if (observer && observedTarget?.isConnected) return;
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      observedTarget = null;

      if (!parseDebounce) {
        parseDebounce = createChurnResistantDebounce(() => {
          if (checkAndHandlePageIssue()) return;

          const parsed = parseCurrentPage();
          const newProducts = dedupEnabled
            ? dedup.mergeAndFilterNew(collectedProducts, parsed).newProducts
            : parsed;
          if (newProducts.length > 0) {
            collectedProducts.push(...newProducts);
            sendMessage({
              type: 'PRODUCTS_COLLECTED',
              payload: {
                products: newProducts,
                totalCount: collectedProducts.length,
                isNewBatch: true,
              },
            });
            sendProgress();
          }
        });
      }

      observer = new MutationObserver(() => {
        if (mode !== 'manual') return;
        // Idle guard: hidden tabs need not keep up with churn; the next
        // mutation after the tab becomes visible re-arms the debounce.
        if (document.hidden) return;
        parseDebounce?.notify();
      });

      observedTarget = resolveResultsContainer();
      observer.observe(observedTarget, {
        childList: true,
        subtree: true,
      });
    }

    function stopObserver(): void {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      observedTarget = null;
      parseDebounce?.cancel();
    }

    // Parse the current page based on its dynamically detected type
    function parseCurrentPage(): ScrapedProduct[] {
      try {
        const currentUrl = window.location.href;
        const currentPageType = detectPageType(currentUrl, document);

        switch (currentPageType) {
          case 'search':
            return parseSearchResults(document, currentUrl, parseCache);
          case 'product-detail': {
            const product = parseProductDetail(document, currentUrl);
            return product ? [product] : [];
          }
          case 'category':
          case 'bestsellers':
            return parseCategoryPage(document, currentUrl, 'category', parseCache);
          default: {
            // Multi-parser fallback if URL/DOM did not match a single canonical page type
            const searchResults = parseSearchResults(document, currentUrl, parseCache);
            if (searchResults.length > 0) return searchResults;

            // product-detail parses are NOT cached: one product per page, so
            // there is nothing to amortise (Step 5.1, by design).
            const detailProduct = parseProductDetail(document, currentUrl);
            if (detailProduct) return [detailProduct];

            return parseCategoryPage(document, currentUrl, 'category', parseCache);
          }
        }
      } catch (err) {
        console.warn('[PPHunt] Error parsing current page:', err);
        return [];
      }
    }

    // Send message to background
    function sendMessage(message: Message): void {
      browser.runtime.sendMessage(message).catch((err) => {
        console.warn('[PPHunt] Failed to send message:', err);
      });
    }

    // Send progress update
    function sendProgress(overrideStatus?: 'collecting' | 'paused' | 'completed'): void {
      sendMessage({
        type: 'COLLECTION_PROGRESS',
        payload: {
          // M-1 (SAD-175): include DB-seeded ASINs so the counter never
          // regresses when the accumulator is wiped by a reload/retry.
          collected: preSeededCount + collectedProducts.length,
          target: targetCount,
          status:
            overrideStatus ??
            (scrollController?.isPaused ? 'paused' : 'collecting'),
        },
      });
    }

    // Start auto-scroll
    function startAutoScroll(): void {
      if (scrollController?.isRunning) return;

      // If target is already met before scrolling begins, finish immediately
      if (targetCount > 0 && collectedProducts.length >= targetCount) {
        sendProgress('completed');
        return;
      }

      scrollController = new ScrollController({
        // H-1b (SAD-170): values from settings; defaults identical to the
        // numbers hardcoded before this change (Step 3.0 snapshot).
        scrollAmount: activeScrollCfg?.scrollAmount ?? 800,
        scrollInterval: activeScrollCfg?.scrollInterval ?? 500,
        waitAfterScroll: activeScrollCfg?.waitAfterScroll ?? 1500,
        maxWaitForNew: 5000,
        maxLoadingWait: 15000,
      });

      scrollController.start(
        () => {
          if (checkAndHandlePageIssue()) return;

          // New products detected
          const parsed = parseCurrentPage();
          const newProducts = dedupEnabled
            ? dedup.mergeAndFilterNew(collectedProducts, parsed).newProducts
            : parsed;
          if (newProducts.length > 0) {
            const remaining =
              targetCount > 0
                ? Math.max(0, targetCount - collectedProducts.length)
                : newProducts.length;
            const batch =
              targetCount > 0 ? newProducts.slice(0, remaining) : newProducts;

            if (batch.length > 0) {
              collectedProducts.push(...batch);
              sendMessage({
                type: 'PRODUCTS_COLLECTED',
                payload: {
                  products: batch,
                  totalCount: collectedProducts.length,
                  isNewBatch: true,
                },
              });
            }

            if (targetCount > 0 && collectedProducts.length >= targetCount) {
              scrollController?.stop();
              sendProgress('completed');
              return;
            }
            sendProgress();
          }
        },
        () => {
          if (checkAndHandlePageIssue()) return;

          // End of page or target reached
          sendProgress('completed');
        },
        () => {
          if (checkAndHandlePageIssue()) return false;
          return targetCount <= 0 || collectedProducts.length < targetCount;
        },
        () => {
          // M-2 (SAD-179): count real product cards only — the old union's
          // `a[href*="/dp/"]` term matched carousels, sponsored slots and
          // footer links, resetting staleCount and forcing pointless full
          // re-parses whenever peripheral content lazy-loaded. See
          // count-products.ts for the full rationale.
          return countProductCards(document);
        },
        () => hasActiveLoadingIndicator(document)
      );
    }

    // Listen for commands from background/side panel
    const onRuntimeMessage = (
      message: unknown,
      _sender: unknown,
      sendResponse?: (response?: unknown) => void
    ) => {
      // PING_CONTENT_SCRIPT is a liveness probe outside the messaging-protocol
      // schema; answer it before validation (SAD-164).
      if (
        (message as { type?: unknown } | null)?.type === 'PING_CONTENT_SCRIPT'
      ) {
        sendResponse?.({ ok: true, url: window.location.href });
        return false;
      }

      // H-3 (SAD-164): validate before anything else — including the
      // COLLECT_PRODUCTS ack below — so a malformed command can never start
      // the scraper. Invalid messages are discarded without throwing.
      const validation = validateExtensionMessage(message);
      if (validation.status === 'unknown') return false;
      if (validation.status === 'invalid') {
        console.warn(
          `[Content] Discarding malformed ${validation.type} message: ${validation.issues}`
        );
        sendResponse?.({ ok: false, error: 'INVALID_MESSAGE' });
        return false;
      }
      // The schema now declares `scroll` and `existingAsins` on
      // COLLECT_PRODUCTS (SAD-170), so plain union narrowing types every
      // payload field — no local type surgery needed anymore.
      const msg = validation.message;

      try {
        switch (msg.type) {
          case 'COLLECT_PRODUCTS': {
            // Acknowledge handshake immediately so the message channel never times out during heavy DOM parsing
            sendResponse?.({ ok: true });

            scrollController?.stop();
            stopObserver();
            collectedProducts.length = 0;
            dedup.clear?.();
            parseCache.clear();

            mode = msg.payload.mode;
            targetCount = msg.payload.targetCount;

            // H-1b (SAD-170): honour the persisted scroll settings carried by
            // the message; absent (older background) -> pre-wiring defaults.
            activeScrollCfg = msg.payload.scroll;
            dedupEnabled = msg.payload.scroll?.duplicateDetection ?? true;

            // Pre-seed deduplication engine with any existing session ASINs
            // (M-1, SAD-175: the background finally sends this field, and the
            // seeds count toward the reported total). Gated on dedupEnabled:
            // with detection off, seeded items must not be filtered NOR
            // counted, or re-parsed rows would be double-counted.
            const existingAsins = msg.payload.existingAsins;
            preSeededCount = 0;
            if (dedupEnabled && Array.isArray(existingAsins)) {
              for (const asin of existingAsins) {
                if (typeof asin === 'string') {
                  dedup.add({ asin });
                  preSeededCount += 1;
                }
              }
            }

            console.log(
              `[PPHunt] Starting collection: ${mode}, target: ${targetCount}`
            );

            if (checkAndHandlePageIssue()) {
              return false;
            }

            // Parse current page for this collection run
            const latestParsed = parseCurrentPage();
            const unique = dedupEnabled
              ? dedup.filterNew(latestParsed)
              : latestParsed;
            const initialBatch =
              mode === 'automatic' && targetCount > 0
                ? unique.slice(0, targetCount)
                : unique;

            if (initialBatch.length > 0) {
              collectedProducts.push(...initialBatch);
              sendMessage({
                type: 'PRODUCTS_COLLECTED',
                payload: {
                  products: collectedProducts,
                  totalCount: collectedProducts.length,
                  isNewBatch: true,
                },
              });
            }

            if (mode === 'automatic') {
              if (targetCount > 0 && collectedProducts.length >= targetCount) {
                sendProgress('completed');
              } else {
                sendProgress('collecting');
                startAutoScroll();
              }
            } else {
              sendProgress('collecting');
              startObserver();
            }
            return false;
          }

          case 'PAUSE_SCROLLING':
            sendResponse?.({ ok: true });
            scrollController?.pause();
            stopObserver();
            sendProgress('paused');
            return false;

          case 'RESUME_SCROLLING': {
            sendResponse?.({ ok: true });
            // H-9a (SAD-177): a resumed run must not inherit stale parses.
            parseCache.clear();
            if (checkAndHandlePageIssue()) {
              return false;
            }

            // Capture any products visible after resolving a CAPTCHA/sign-in
            const parsedOnResume = parseCurrentPage();
            const { newProducts } = dedup.mergeAndFilterNew(
              collectedProducts,
              parsedOnResume
            );
            if (newProducts.length > 0) {
              const remaining =
                mode === 'automatic' && targetCount > 0
                  ? Math.max(0, targetCount - collectedProducts.length)
                  : newProducts.length;
              const batch =
                mode === 'automatic' && targetCount > 0
                  ? newProducts.slice(0, remaining)
                  : newProducts;

              if (batch.length > 0) {
                collectedProducts.push(...batch);
                sendMessage({
                  type: 'PRODUCTS_COLLECTED',
                  payload: {
                    products: batch,
                    totalCount: collectedProducts.length,
                    isNewBatch: true,
                  },
                });
              }
            }

            if (mode === 'automatic') {
              if (targetCount > 0 && collectedProducts.length >= targetCount) {
                scrollController?.stop();
                sendProgress('completed');
              } else if (scrollController?.isPaused) {
                scrollController.resume();
                sendProgress('collecting');
              } else {
                sendProgress('collecting');
                startAutoScroll();
              }
            } else {
              startObserver();
              sendProgress('collecting');
            }
            return false;
          }

          case 'STOP_COLLECTION_CMD':
            sendResponse?.({ ok: true });
            scrollController?.stop();
            stopObserver();
            sendProgress('completed');
            return false;
        }
      } catch (err) {
        console.error('[PPHunt] Content script command handler error:', err);
        sendMessage({
          type: 'CONTENT_ERROR',
          payload: {
            code: 'UNKNOWN',
            message:
              err instanceof Error
                ? err.message
                : 'An unexpected error occurred in the page helper script.',
          } as any,
        });
      }

      return false;
    };

    const onDomCommand = (event: Event) => {
      const detail = (event as CustomEvent)?.detail;
      if (detail?.type) {
        onRuntimeMessage(detail, {}, () => {});
      }
    };

    browser.runtime.onMessage.addListener(onRuntimeMessage as any);
    document.addEventListener('__PPHUNT_COMMAND__', onDomCommand);
    (
      win as unknown as {
        __PPHUNT_DISPATCH_COMMAND__?: (cmd: unknown) => { ok: boolean };
      }
    ).__PPHUNT_DISPATCH_COMMAND__ = (cmd: unknown) => {
      onRuntimeMessage(cmd, {}, () => {});
      return { ok: true };
    };

    win.__PPHUNT_CONTENT_CLEANUP__ = () => {
      scrollController?.stop();
      stopObserver();
      browser.runtime.onMessage.removeListener?.(onRuntimeMessage as any);
      document.removeEventListener('__PPHUNT_COMMAND__', onDomCommand);
    };
  },
});
