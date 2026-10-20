import {
  validateTemuContentIncomingMessage,
  isTemuMessage,
} from '@/engines/temu/schemas/validate-message';
import { detectTemuChallengeOrRestriction } from '@/engines/temu/scraper/captcha-detector';
import {
  createFieldDiagnosticsCollector,
  type ExtractionDiagnosticsReport,
} from '@/engines/temu/scraper/extraction-diagnostics';
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
    const win = window as unknown as {
      __PPHUNT_TEMU_CONTENT_CLEANUP__?: () => void;
      __PPHUNT_TEMU_DISPATCH_COMMAND__?: (msg: unknown) => { ok: boolean };
    };
    if (typeof win.__PPHUNT_TEMU_CONTENT_CLEANUP__ === 'function') {
      try {
        win.__PPHUNT_TEMU_CONTENT_CLEANUP__();
      } catch {
        // Ignore cleanup errors from prior content-script instance
      }
    }

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
    /** SAD-360: goodsIds already sent with products from this page. */
    let initialGoodsIds = new Set<string | null>();

    function sendRuntimeMessage(message: unknown): void {
      try {
        const maybePromise = browser.runtime.sendMessage(message);
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => {});
        }
      } catch {
        // Ignore runtime context invalidated errors
      }
    }

    interface ParsedPage {
      products: TemuScrapedProduct[];
      /** SAD-360: reports for every product parsed on this pass. */
      diagnostics: ExtractionDiagnosticsReport[];
      /** A1: a PDP whose goodsId could not be resolved at all. */
      nullIdReport?: ExtractionDiagnosticsReport;
      pageType: TemuPageType;
    }

    function parsePdpPage(url: string): {
      product: TemuScrapedProduct | null;
      report: ExtractionDiagnosticsReport;
    } {
      const collector = createFieldDiagnosticsCollector('product_detail');
      const product = parseTemuProductDetail(document, url, collector);
      return { product, report: collector.build() };
    }

    function parseCurrentPage(): ParsedPage {
      const url = window.location.href;
      const detectedType = detectTemuPageType(url, document);

      let rawProducts: TemuScrapedProduct[] = [];
      let diagnostics: ExtractionDiagnosticsReport[] = [];
      let nullIdReport: ExtractionDiagnosticsReport | undefined;

      switch (detectedType) {
        case 'search': {
          const byGoodsId = new Map<string, ExtractionDiagnosticsReport>();
          rawProducts = parseTemuSearchResults(
            document,
            url,
            parseCache,
            'search',
            byGoodsId
          );
          diagnostics = [...byGoodsId.values()];
          break;
        }
        case 'product_detail': {
          const parsed = parsePdpPage(url);
          if (parsed.product) {
            rawProducts = [parsed.product];
            diagnostics = [parsed.report];
          } else if (parsed.report.goodsId === null) {
            nullIdReport = parsed.report;
          }
          break;
        }
        case 'category': {
          const byGoodsId = new Map<string, ExtractionDiagnosticsReport>();
          rawProducts = parseTemuCategoryPage(
            document,
            url,
            'category',
            parseCache,
            byGoodsId
          );
          diagnostics = [...byGoodsId.values()];
          break;
        }
        default: {
          const parsed = parsePdpPage(url);
          if (parsed.product) {
            rawProducts = [parsed.product];
            diagnostics = [parsed.report];
          } else {
            if (parsed.report.goodsId === null) {
              nullIdReport = parsed.report;
            }
            const byGoodsId = new Map<string, ExtractionDiagnosticsReport>();
            rawProducts = parseTemuCategoryPage(
              document,
              url,
              'category',
              parseCache,
              byGoodsId
            );
            diagnostics = [...byGoodsId.values()];
          }
          break;
        }
      }

      if (!duplicateDetectionEnabled) {
        return { products: rawProducts, diagnostics, nullIdReport, pageType: detectedType };
      }

      const { newProducts, updatedExisting } = dedup.mergeAndFilterNew(
        collectedSoFar,
        rawProducts
      );

      if (updatedExisting && newProducts.length === 0) {
        sendRuntimeMessage({
          type: 'TEMU_PRODUCTS_COLLECTED',
          payload: {
            products: collectedSoFar,
            pageType: detectedType,
            pageUrl: url,
            totalOnPage: countTemuProductCardsOnPage(document),
          },
        });
      }

      return { products: newProducts, diagnostics, nullIdReport, pageType: detectedType };
    }

    /** SAD-360: reports already sent from this page, so re-parses stay quiet. */
    const sentDiagnosticKeys = new Set<string>();

    function diagnosticsKey(report: ExtractionDiagnosticsReport): string {
      return `${report.goodsId ?? 'no-goods-id'}|${report.stage}`;
    }

    function freshDiagnostics(
      reports: ExtractionDiagnosticsReport[],
      allowedGoodsIds: Set<string | null> | null
    ): ExtractionDiagnosticsReport[] {
      const fresh: ExtractionDiagnosticsReport[] = [];
      for (const report of reports) {
        if (allowedGoodsIds && !allowedGoodsIds.has(report.goodsId)) continue;
        const key = diagnosticsKey(report);
        if (sentDiagnosticKeys.has(key)) continue;
        sentDiagnosticKeys.add(key);
        fresh.push(report);
        if (fresh.length >= 200) break;
      }
      return fresh;
    }

    function sendProductsToBackground(
      newProducts: TemuScrapedProduct[],
      pageDiagnostics: ExtractionDiagnosticsReport[] = []
    ): void {
      if (newProducts.length === 0) return;

      const remainingAllowance =
        targetCount > 0
          ? Math.max(0, targetCount - (seededCount + collectedSoFar.length))
          : newProducts.length;
      const boundedProducts =
        remainingAllowance > 0
          ? newProducts.slice(0, remainingAllowance)
          : [];

      if (boundedProducts.length === 0) return;

      collectedSoFar.push(...boundedProducts);
      const totalCollected = seededCount + collectedSoFar.length;

      // Only the products actually in this message carry their report (D4/A3).
      const boundedGoodsIds = new Set<string | null>(
        boundedProducts.map((product) => product.goodsId)
      );
      const productDiagnostics = freshDiagnostics(
        pageDiagnostics,
        boundedGoodsIds
      );

      sendRuntimeMessage({
        type: 'TEMU_PRODUCTS_COLLECTED',
        payload: {
          products: boundedProducts,
          pageType: detectTemuPageType(window.location.href, document),
          pageUrl: window.location.href,
          totalOnPage: countTemuProductCardsOnPage(document),
          ...(productDiagnostics.length > 0 ? { productDiagnostics } : {}),
        },
      });

      const willCompleteNow =
        isCollecting &&
        ((targetCount > 0 && totalCollected >= targetCount) ||
          detectTemuPageType(window.location.href, document) ===
            'product_detail');

      if (!willCompleteNow) {
        sendRuntimeMessage({
          type: 'TEMU_COLLECTION_PROGRESS',
          payload: {
            collectedCount: totalCollected,
            targetCount,
            status: 'collecting',
            scrollCount: scrollController?.currentScrollCount ?? 0,
          },
        });
      }

      if (targetCount > 0 && totalCollected >= targetCount) {
        stopCollection('target_reached');
      }
    }

    /**
     * SAD-360 A3: a stage parsed on a later visit (e.g. the PDP of a product
     * collected from search) still has value, but it must never re-save the
     * product. The background verifies persisted membership before logging.
     */
    function sendLaterStageDiagnostics(
      pageDiagnostics: ExtractionDiagnosticsReport[],
      alreadySent: Set<string | null>
    ): void {
      const laterStage = freshDiagnostics(pageDiagnostics, null).filter(
        (report) => report.goodsId === null || !alreadySent.has(report.goodsId)
      );
      if (laterStage.length === 0) return;
      sendRuntimeMessage({
        type: 'TEMU_PRODUCTS_COLLECTED',
        payload: {
          products: [],
          pageType: detectTemuPageType(window.location.href, document),
          pageUrl: window.location.href,
          totalOnPage: countTemuProductCardsOnPage(document),
          productDiagnostics: laterStage,
        },
      });
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
        sendRuntimeMessage({
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
        });
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

      sentDiagnosticKeys.clear();
      const initialProducts = parseCurrentPage();
      initialGoodsIds = new Set<string | null>(
        initialProducts.products.map((product) => product.goodsId)
      );
      sendProductsToBackground(
        initialProducts.products,
        initialProducts.diagnostics
      );
      if (initialProducts.nullIdReport) {
        sendLaterStageDiagnostics([initialProducts.nullIdReport], new Set());
      }

      if (targetCount > 0 && seededCount + collectedSoFar.length >= targetCount) {
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
            sendProductsToBackground(newBatch.products, newBatch.diagnostics);
            if (newBatch.nullIdReport) {
              sendLaterStageDiagnostics([newBatch.nullIdReport], new Set());
            }
          },
          onEndOfPage: () => {
            const finalBatch = parseCurrentPage();
            sendProductsToBackground(finalBatch.products, finalBatch.diagnostics);
            if (finalBatch.nullIdReport) {
              sendLaterStageDiagnostics([finalBatch.nullIdReport], new Set());
            }
            if (isCollecting) {
              stopCollection('no_more_results');
            }
          },
          onCaptchaDetected: (reason) => {
            sendRuntimeMessage({
              type: 'TEMU_COLLECTION_ERROR',
              payload: {
                code: 'TEMU_CAPTCHA_DETECTED',
                category: 'captcha',
                title: 'Verification Required',
                message: reason,
                remedy:
                  'Complete the verification prompt in the Temu tab, then click Resume in PPHunt.',
              },
            });
          },
          onError: (errMsg) => {
            sendRuntimeMessage({
              type: 'TEMU_COLLECTION_ERROR',
              payload: {
                code: 'TEMU_SCROLL_ERROR',
                category: 'unknown',
                title: 'Scroll Error',
                message: `An error occurred while scrolling Temu: ${errMsg}`,
                remedy:
                  'Try switching to Manual mode or refreshing the Temu tab.',
              },
            });
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

      sendRuntimeMessage({
        type: 'TEMU_COLLECTION_COMPLETE',
        payload: {
          totalCollected: seededCount + collectedSoFar.length,
          reason,
        },
      });
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
        sendProductsToBackground(newBatch.products, newBatch.diagnostics);
        // A3: cards that were already collected this page get a diagnostics-only
        // message; the background re-checks persisted membership before logging.
        sendLaterStageDiagnostics(newBatch.diagnostics, initialGoodsIds);
        if (newBatch.nullIdReport) {
          sendLaterStageDiagnostics([newBatch.nullIdReport], new Set());
        }
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

    const onRuntimeMessage = (
      rawMessage: unknown,
      _sender: unknown,
      sendResponse: (response?: unknown) => void
    ) => {
      if (!isTemuMessage(rawMessage)) return false;
      const response = handleCommand(rawMessage);
      if (response !== null) {
        sendResponse(response);
      }
      return false;
    };

    const onDomCommand = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        handleCommand(customEvent.detail);
      }
    };

    browser.runtime.onMessage.addListener(
      onRuntimeMessage as Parameters<
        typeof browser.runtime.onMessage.addListener
      >[0]
    );
    document.addEventListener('__PPHUNT_TEMU_COMMAND__', onDomCommand);
    win.__PPHUNT_TEMU_DISPATCH_COMMAND__ = (cmd: unknown) => {
      handleCommand(cmd);
      return { ok: true };
    };

    win.__PPHUNT_TEMU_CONTENT_CLEANUP__ = () => {
      scrollController?.stop();
      teardownMutationObserver();
      browser.runtime.onMessage.removeListener?.(
        onRuntimeMessage as Parameters<
          typeof browser.runtime.onMessage.removeListener
        >[0]
      );
      document.removeEventListener('__PPHUNT_TEMU_COMMAND__', onDomCommand);
    };
  },
});
