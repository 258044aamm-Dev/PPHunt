import {
  validateTemuContentIncomingMessage,
  isTemuMessage,
} from '@/engines/temu/schemas/validate-message';
import { detectTemuChallengeOrRestriction } from '@/engines/temu/scraper/captcha-detector';
import { parseTemuCategoryPage } from '@/engines/temu/scraper/category-page';
import { TemuDeduplicationEngine } from '@/engines/temu/scraper/dedup';
import {
  countTemuProductCardsOnPage,
  detectTemuPageType,
  extractTemuSearchQuery,
} from '@/engines/temu/scraper/page-detector';
import { TemuParseCache } from '@/engines/temu/scraper/parse-cache';
import { parseTemuProductDetail } from '@/engines/temu/scraper/product-detail';
import { TemuScrollController } from '@/engines/temu/scraper/scroll-controller';
import { parseTemuSearchResults } from '@/engines/temu/scraper/search-results';
import { TEMU_SELECTORS } from '@/engines/temu/scraper/selectors';
import type {
  TemuCollectionMode,
  TemuPageType,
  TemuScrapedProduct,
} from '@/engines/temu/types';

export default defineContentScript({
  matches: ['*://*.temu.com/*', '*://temu.com/*'],
  runAt: 'document_idle',

  main() {
    const win = window as Window & {
      __PPHUNT_TEMU_CONTENT_SCRIPT_ACTIVE__?: boolean;
      __PPHUNT_TEMU_DISPATCH_COMMAND__?: (msg: unknown) => void;
    };
    if (win.__PPHUNT_TEMU_CONTENT_SCRIPT_ACTIVE__) {
      return;
    }
    win.__PPHUNT_TEMU_CONTENT_SCRIPT_ACTIVE__ = true;

    const currentUrl = window.location.href;
    const pageType: TemuPageType = detectTemuPageType(currentUrl, document);

    console.log('[PPHunt:Temu] Content script loaded on:', currentUrl);
    console.log('[PPHunt:Temu] Page type:', pageType);

    let dedup = new TemuDeduplicationEngine();
    const parseCache = new TemuParseCache();
    let scrollController: TemuScrollController | null = null;
    let mutationObserver: MutationObserver | null = null;
    let isCollecting = false;
    let targetCount = 50;
    let collectedSoFar: TemuScrapedProduct[] = [];
    let seededCount = 0;
    let duplicateDetectionEnabled = true;

    function parseCurrentPage(): TemuScrapedProduct[] {
      const url = window.location.href;
      const detectedType = detectTemuPageType(url, document);

      let rawProducts: TemuScrapedProduct[] = [];
      switch (detectedType) {
        case 'search':
          rawProducts = parseTemuSearchResults(
            document,
            url,
            parseCache,
            'search'
          );
          break;
        case 'product_detail': {
          const single = parseTemuProductDetail(document, url);
          if (single) rawProducts = [single];
          break;
        }
        case 'category':
          rawProducts = parseTemuCategoryPage(
            document,
            url,
            'category',
            parseCache
          );
          break;
        default: {
          const detailFallback = parseTemuProductDetail(document, url);
          if (detailFallback) {
            rawProducts = [detailFallback];
          } else {
            rawProducts = parseTemuCategoryPage(
              document,
              url,
              'category',
              parseCache
            );
          }
          break;
        }
      }

      if (!duplicateDetectionEnabled) {
        return rawProducts;
      }

      const { newProducts, updatedExisting } = dedup.mergeAndFilterNew(
        collectedSoFar,
        rawProducts
      );

      if (updatedExisting && newProducts.length === 0) {
        chrome.runtime
          .sendMessage({
            type: 'TEMU_PRODUCTS_COLLECTED',
            payload: {
              products: collectedSoFar,
              pageType: detectedType,
              pageUrl: url,
              totalOnPage: countTemuProductCardsOnPage(document),
            },
          })
          .catch(() => {});
      }

      return newProducts;
    }

    function sendProductsToBackground(newProducts: TemuScrapedProduct[]): void {
      if (newProducts.length === 0) return;

      const remainingAllowance = Math.max(
        0,
        targetCount - (seededCount + collectedSoFar.length)
      );
      const boundedProducts =
        remainingAllowance > 0
          ? newProducts.slice(0, remainingAllowance)
          : [];

      if (boundedProducts.length === 0) return;

      collectedSoFar.push(...boundedProducts);
      const totalCollected = seededCount + collectedSoFar.length;

      chrome.runtime
        .sendMessage({
          type: 'TEMU_PRODUCTS_COLLECTED',
          payload: {
            products: boundedProducts,
            pageType: detectTemuPageType(window.location.href, document),
            pageUrl: window.location.href,
            totalOnPage: countTemuProductCardsOnPage(document),
          },
        })
        .catch((err) => {
          console.warn(
            '[PPHunt:Temu] Failed to send products to background:',
            err
          );
        });

      chrome.runtime
        .sendMessage({
          type: 'TEMU_COLLECTION_PROGRESS',
          payload: {
            collectedCount: totalCollected,
            targetCount,
            status: 'collecting',
            scrollCount: scrollController?.currentScrollCount ?? 0,
          },
        })
        .catch(() => {});

      if (totalCollected >= targetCount) {
        stopCollection('target_reached');
      }
    }

    function startCollection(
      mode: TemuCollectionMode,
      target: number,
      scrollSettings?: {
        scrollAmount: number;
        scrollInterval: number;
        waitAfterScroll: number;
      },
      duplicateDetection?: boolean,
      existingGoodsIds?: string[]
    ): void {
      if (isCollecting) stopCollection('user_stopped');

      // Check for active verification/CAPTCHA challenge before starting
      const restriction = detectTemuChallengeOrRestriction(document);
      if (restriction.restricted) {
        chrome.runtime
          .sendMessage({
            type: 'TEMU_COLLECTION_ERROR',
            payload: {
              code:
                restriction.kind === 'captcha'
                  ? 'TEMU_CAPTCHA_DETECTED'
                  : 'TEMU_ACCESS_RESTRICTED',
              category:
                restriction.kind === 'captcha'
                  ? 'captcha'
                  : 'page_compatibility',
              title:
                restriction.kind === 'captcha'
                  ? 'Verification Required'
                  : 'Access Temporarily Restricted',
              message:
                restriction.reason ??
                'Temu requires verification before products can be collected.',
              remedy:
                'Complete the verification challenge directly in the Temu tab, then click Resume or Start Collection.',
            },
          })
          .catch(() => {});
        return;
      }

      isCollecting = true;
      targetCount = target;
      collectedSoFar = [];
      duplicateDetectionEnabled = duplicateDetection ?? true;
      const seeds =
        duplicateDetectionEnabled && existingGoodsIds
          ? existingGoodsIds.map((goodsId) => ({ goodsId, asin: goodsId }))
          : [];
      dedup = new TemuDeduplicationEngine(seeds);
      seededCount = dedup.size;
      parseCache.clear();

      const initialProducts = parseCurrentPage();
      sendProductsToBackground(initialProducts);

      if (seededCount + collectedSoFar.length >= targetCount) {
        return;
      }

      setupMutationObserver();

      if (
        mode === 'automatic' &&
        detectTemuPageType(window.location.href, document) !== 'product_detail'
      ) {
        scrollController = new TemuScrollController({
          scrollAmount: scrollSettings?.scrollAmount ?? 800,
          scrollInterval: scrollSettings?.scrollInterval ?? 1500,
          waitAfterScroll: scrollSettings?.waitAfterScroll ?? 2000,
          maxStaleScrolls: 5,
          countProducts: () => countTemuProductCardsOnPage(document),
          onNewProducts: () => {
            const newBatch = parseCurrentPage();
            sendProductsToBackground(newBatch);
          },
          onEndOfPage: () => {
            const finalBatch = parseCurrentPage();
            sendProductsToBackground(finalBatch);
            if (isCollecting) {
              stopCollection('no_more_results');
            }
          },
          onCaptchaDetected: (reason) => {
            chrome.runtime
              .sendMessage({
                type: 'TEMU_COLLECTION_ERROR',
                payload: {
                  code: 'TEMU_CAPTCHA_DETECTED',
                  category: 'captcha',
                  title: 'Verification Required',
                  message: reason,
                  remedy:
                    'Complete the verification prompt in the Temu tab, then click Resume in PPHunt.',
                },
              })
              .catch(() => {});
          },
          onError: (errMsg) => {
            chrome.runtime
              .sendMessage({
                type: 'TEMU_COLLECTION_ERROR',
                payload: {
                  code: 'TEMU_SCROLL_ERROR',
                  category: 'unknown',
                  title: 'Scroll Error',
                  message: `An error occurred while scrolling Temu: ${errMsg}`,
                  remedy:
                    'Try switching to Manual mode or refreshing the Temu tab.',
                },
              })
              .catch(() => {});
          },
        });
        scrollController.start();
      }
    }

    function stopCollection(
      reason:
        | 'target_reached'
        | 'no_more_results'
        | 'user_stopped'
        | 'error' = 'user_stopped'
    ): void {
      isCollecting = false;
      scrollController?.stop();
      scrollController = null;
      teardownMutationObserver();

      chrome.runtime
        .sendMessage({
          type: 'TEMU_COLLECTION_COMPLETE',
          payload: {
            totalCollected: seededCount + collectedSoFar.length,
            reason,
          },
        })
        .catch(() => {});
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let firstMutationAt: number | null = null;
    const DEBOUNCE_DELAY_MS = 250;
    const DEBOUNCE_MAX_WAIT_MS = 1000;

    function resolveObserverTarget(): Node {
      const detected = detectTemuPageType(window.location.href, document);
      if (detected === 'search' || detected === 'category') {
        const scoped = document.querySelector(
          TEMU_SELECTORS.listing.resultsContainer
        );
        if (scoped) return scoped;
      }
      return document.body;
    }

    function setupMutationObserver(): void {
      teardownMutationObserver();

      const flush = () => {
        debounceTimer = null;
        firstMutationAt = null;
        if (!isCollecting) return;
        if (typeof document === 'undefined' || !document.body) return;
        const newBatch = parseCurrentPage();
        sendProductsToBackground(newBatch);
      };

      mutationObserver = new MutationObserver((mutations) => {
        if (!isCollecting) return;
        if (typeof document === 'undefined' || !document.body) return;

        const hasAddedElements = mutations.some((m) =>
          Array.from(m.addedNodes).some((n) => n.nodeType === Node.ELEMENT_NODE)
        );
        if (!hasAddedElements) return;

        const now = Date.now();
        if (firstMutationAt === null) firstMutationAt = now;
        if (now - firstMutationAt >= DEBOUNCE_MAX_WAIT_MS) {
          if (debounceTimer) clearTimeout(debounceTimer);
          flush();
          return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, DEBOUNCE_DELAY_MS);
      });

      mutationObserver.observe(resolveObserverTarget(), {
        childList: true,
        subtree: true,
      });
    }

    function teardownMutationObserver(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      firstMutationAt = null;
      mutationObserver?.disconnect();
      mutationObserver = null;
    }

    function handleCommand(rawMessage: unknown): unknown {
      if (!isTemuMessage(rawMessage)) return null;
      const message = validateTemuContentIncomingMessage(rawMessage);
      if (!message) return null;

      switch (message.type) {
        case 'TEMU_COLLECT_PRODUCTS': {
          const {
            mode,
            targetCount: target,
            scroll,
            duplicateDetection,
            existingGoodsIds,
          } = message.payload;
          startCollection(
            mode,
            target,
            scroll,
            duplicateDetection,
            existingGoodsIds
          );
          return { status: 'started', count: collectedSoFar.length };
        }

        case 'TEMU_PAUSE_SCROLLING': {
          scrollController?.pause();
          return { status: 'paused' };
        }

        case 'TEMU_RESUME_SCROLLING': {
          scrollController?.resume();
          return { status: 'resumed' };
        }

        case 'TEMU_STOP_COLLECTION_CMD': {
          stopCollection('user_stopped');
          return { status: 'stopped', count: collectedSoFar.length };
        }

        case 'TEMU_GET_PAGE_STATUS': {
          const currentPageType = detectTemuPageType(
            window.location.href,
            document
          );
          return {
            type: 'TEMU_PAGE_STATUS',
            payload: {
              isTemuPage: currentPageType !== 'unknown',
              pageType: currentPageType,
              url: window.location.href,
              productCountOnPage: countTemuProductCardsOnPage(document),
              searchQuery: extractTemuSearchQuery(
                window.location.href,
                document
              ),
            },
          };
        }
      }
    }

    win.__PPHUNT_TEMU_DISPATCH_COMMAND__ = (msg: unknown) => {
      handleCommand(msg);
    };
    window.addEventListener('pphunt:temu:command', (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        handleCommand(customEvent.detail);
      }
    });

    chrome.runtime.onMessage.addListener(
      (
        rawMessage: unknown,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void
      ) => {
        if (!isTemuMessage(rawMessage)) return false;
        const response = handleCommand(rawMessage);
        if (response !== null) {
          sendResponse(response);
        }
        return false;
      }
    );
  },
});
