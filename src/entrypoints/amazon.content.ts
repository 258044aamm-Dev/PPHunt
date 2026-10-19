import { AMAZON_MATCH_PATTERNS } from '@/engines/amazon/constants/match-patterns';
import {
  createCardActionLayer,
  type CardActionJobUpdate,
} from '@/engines/amazon/content/card-action-layer';
import {
  buildSaveContext,
  extractProductFromCard,
  resolveSaveCandidate,
} from '@/engines/amazon/content/save-product';
import { createCollectionChoiceQueue } from '@/engines/amazon/content/collection-choice-dialog';
import { captureSaveTarget, type CapturedSaveTarget } from '@/engines/amazon/content/save-target';
import { removeSaveToast, showSaveToast } from '@/engines/amazon/content/toast';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';
import { validateExtensionMessage } from '@/engines/amazon/schemas/validate-message';
import { ScrollController } from '@/lib/scraper/scroll-controller';
import {
  AmazonDeduplicationEngine,
  AmazonParseCache,
  countProductCards,
  createChurnResistantDebounce,
  defaultAmazonDriftTelemetry,
  detectAmazonPageType,
  detectPageIssues,
  extractAmazonSearchQuery,
  hasActiveLoadingIndicator,
  parseAmazonCategoryPage,
  parseAmazonProductDetail,
  parseAmazonSearchResults,
} from '@/engines/amazon/scraper';


interface CollectProductsCommandPayload {
  mode: 'manual' | 'automatic';
  targetCount: number;
  scroll?: {
    scrollAmount?: number;
    scrollInterval?: number;
    waitAfterScroll?: number;
    duplicateDetection?: boolean;
  };
  existingAsins?: string[];
}

function sendRuntimeMessageSafe(message: Record<string, unknown>): void {
  try {
    const result = browser.runtime.sendMessage(message);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {
        // Ignore transient background disconnection
      });
    }
  } catch {
    // Ignore synchronous runtime context invalidation
  }
}

function mintSaveJobId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the timestamp form
  }
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function extractCurrentPageProducts(
  doc: Document,
  url: string,
  cache: AmazonParseCache,
): ScrapedAmazonProduct[] {
  const pageType = detectAmazonPageType(url, doc);

  if (pageType === 'product-detail') {
    const detail = parseAmazonProductDetail(doc, url);
    return detail ? [detail] : [];
  }

  if (pageType === 'search') {
    const searchItems = parseAmazonSearchResults(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
    });
    if (searchItems.length > 0) return searchItems;
    return parseAmazonCategoryPage(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
    });
  }

  if (pageType === 'bestsellers' || pageType === 'category') {
    const categoryItems = parseAmazonCategoryPage(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
    });
    if (categoryItems.length > 0) return categoryItems;
    return parseAmazonSearchResults(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
    });
  }

  // Fallback for unclassified Amazon pages that still contain product cards
  const searchFallback = parseAmazonSearchResults(doc, url, {
    cache,
    telemetry: defaultAmazonDriftTelemetry,
  });
  if (searchFallback.length > 0) return searchFallback;

  return parseAmazonCategoryPage(doc, url, {
    cache,
    telemetry: defaultAmazonDriftTelemetry,
  });
}

export default defineContentScript({
  matches: [...AMAZON_MATCH_PATTERNS],
  runAt: 'document_idle',

  main() {
    const win = window as unknown as {
      __PPHUNT_CONTENT_CLEANUP__?: () => void;
    };

    try {
      win.__PPHUNT_CONTENT_CLEANUP__?.();
    } catch {
      // Ignore previous cleanup errors
    }

    let isCollecting = false;
    let currentMode: 'manual' | 'automatic' = 'manual';
    let targetCount = 100;
    let duplicateDetection = true;
    let collectedProducts: ScrapedAmazonProduct[] = [];
    const dedup = new AmazonDeduplicationEngine();
    const parseCache = new AmazonParseCache();
    let scrollController: ScrollController | null = null;
    let mutationObserver: MutationObserver | null = null;
    let lastKnownUrl = window.location.href;
    let lastSaveCapture: CapturedSaveTarget | null = null;
    let pendingSaveJobId: string | null = null;
    let cardActionLayer: ReturnType<typeof createCardActionLayer> | null = null;

    /**
     * SAD-287: the save already happened, so cancelling (or the 30 s timeout)
     * sends nothing and the row stays where it was written. Only an explicit
     * "Create new collection" reaches the background.
     */
    const collectionChoiceQueue = createCollectionChoiceQueue({
      onChoice: (jobId, choice) => {
        if (choice === 'cancel') return;
        sendRuntimeMessageSafe({
          type: 'ASSIGN_SAVED_PRODUCT',
          payload: { jobId, choice },
        });
      },
    });

    /**
     * SAD-281: the background cannot see the page (no element in
     * `contextMenus.OnClickData`), so it asks and this resolves the product that
     * was under the pointer when the menu opened.
     */
    const handleSaveContextProduct = () => {
      const pageUrl = window.location.href;
      const candidate = resolveSaveCandidate({
        capture: lastSaveCapture,
        pageUrl,
        triggeredBy: 'context-menu',
      });

      if (!candidate) {
        showSaveToast({ state: 'failed', message: 'No product found here' });
        return;
      }

      const jobId = mintSaveJobId();
      pendingSaveJobId = jobId;
      sendRuntimeMessageSafe({
        type: 'SAVE_PRODUCT',
        payload: { jobId, product: candidate.product, context: candidate.context },
      });
      showSaveToast({ state: 'queued', message: 'Saving product…' });
    };

    const handleSaveJobUpdate = (payload: CardActionJobUpdate) => {
      // Card buttons route by ASIN; the menu path below tracks its own job id.
      cardActionLayer?.applyJobUpdate(payload);

      // The dialog is independent of which entry point started the save, and the
      // queue drops duplicate deliveries of the same job id.
      if (
        payload.state === 'completed' &&
        payload.requiresCollectionChoice &&
        typeof payload.jobId === 'string' &&
        payload.jobId.length > 0
      ) {
        collectionChoiceQueue.enqueue({
          jobId: payload.jobId,
          ...(payload.productTitle ? { productTitle: payload.productTitle } : {}),
          collectionLabel: payload.collectionLabel ?? 'this collection',
        });
      }

      if (!pendingSaveJobId || payload.jobId !== pendingSaveJobId) return;

      if (payload.state === 'completed') {
        const completedJobId = pendingSaveJobId;
        pendingSaveJobId = null;
        showSaveToast({
          state: 'completed',
          message: payload.message ?? 'Saved to History',
          // SAD-336: the worker says what the product page could not provide.
          // A save with no warning renders exactly as it did before.
          ...(payload.warning ? { detail: payload.warning } : {}),
          // SAD-291: the format comes from settings in the worker, so the label
          // stays generic; a failure there is reported by the same channel and
          // never turns a successful save into a failure.
          action: {
            label: 'Download',
            onClick: () => {
              sendRuntimeMessageSafe({
                type: 'EXPORT_SAVED_PRODUCT',
                payload: { jobId: completedJobId },
              });
            },
          },
        });
        return;
      }

      if (payload.state === 'failed') {
        pendingSaveJobId = null;
        showSaveToast({
          state: 'failed',
          message: payload.message ?? 'Could not save this product',
        });
      }
    };

    const reportPageInfo = () => {
      const url = window.location.href;
      const pageType = detectAmazonPageType(url, document);
      const searchQuery = extractAmazonSearchQuery(url, document);
      const productCount = countProductCards(document);

      sendRuntimeMessageSafe({
        type: 'PAGE_INFO',
        payload: {
          pageType,
          url,
          ...(searchQuery ? { searchQuery } : {}),
          productCount,
        },
      });
    };

    const getReportedTotal = (): number =>
      duplicateDetection ? dedup.size : collectedProducts.length;

    const stopMutationWatcher = () => {
      if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
      }
    };

    const debouncedManualScrape = createChurnResistantDebounce(
      () => {
        if (!isCollecting || currentMode !== 'manual') return;
        runScrapeBatch(false);
      },
      { debounceMs: 300, maxWaitMs: 2000 },
    );

    const startMutationWatcher = () => {
      stopMutationWatcher();
      if (!document.body || typeof MutationObserver === 'undefined') return;

      mutationObserver = new MutationObserver((mutations) => {
        if (!isCollecting || currentMode !== 'manual') return;
        let hasRelevantMutation = false;
        for (const m of mutations) {
          if (m.addedNodes.length > 0) {
            const targetEl =
              m.target instanceof Element ? m.target : m.target.parentElement;
            if (
              targetEl &&
              (!targetEl.closest('.a-carousel-card') ||
                Boolean(targetEl.closest('.s-main-slot')))
            ) {
              hasRelevantMutation = true;
              break;
            }
          }
        }
        if (hasRelevantMutation) {
          debouncedManualScrape.notify();
        }
      });

      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    };

    const runScrapeBatch = (isNewBatch: boolean): number => {
      const issue = detectPageIssues(document);
      if (issue) {
        sendRuntimeMessageSafe({
          type: 'COLLECTION_ERROR',
          payload: {
            error: issue.message,
            collectedSoFar: getReportedTotal(),
          },
        });
        return getReportedTotal();
      }

      const rawParsed = extractCurrentPageProducts(
        document,
        window.location.href,
        parseCache,
      );

      const { newProducts, updatedExisting } = dedup.mergeAndFilterNew(
        collectedProducts,
        rawParsed,
      );

      if (newProducts.length > 0) {
        collectedProducts.push(...newProducts);
      }

      const totalReported = getReportedTotal();

      if (newProducts.length > 0 || updatedExisting || isNewBatch) {
        const batchToEmit = updatedExisting
          ? collectedProducts
          : newProducts;
        if (batchToEmit.length > 0) {
          sendRuntimeMessageSafe({
            type: 'PRODUCTS_COLLECTED',
            payload: {
              products: batchToEmit,
              totalCount: totalReported,
              isNewBatch,
            },
          });
        }
      }

      const isDetailPage =
        isNewBatch &&
        detectAmazonPageType(window.location.href, document) ===
          'product-detail';
      const willCompleteNow =
        isCollecting && (totalReported >= targetCount || isDetailPage);

      if (!willCompleteNow) {
        sendRuntimeMessageSafe({
          type: 'COLLECTION_PROGRESS',
          payload: {
            collected: totalReported,
            target: targetCount,
            status: 'collecting',
          },
        });
      }

      if (totalReported >= targetCount && isCollecting) {
        finishCollection('target_reached');
      }

      return totalReported;
    };

    const finishCollection = (
      reason: 'target_reached' | 'page_end' | 'manual_stop' | 'error',
    ) => {
      isCollecting = false;
      debouncedManualScrape.cancel();
      stopMutationWatcher();
      if (scrollController) {
        scrollController.stop();
        scrollController = null;
      }

      sendRuntimeMessageSafe({
        type: 'COLLECTION_COMPLETE',
        payload: {
          totalCollected: getReportedTotal(),
          reason,
        },
      });
    };

    const handleCollectProducts = (payload: CollectProductsCommandPayload) => {
      debouncedManualScrape.cancel();
      stopMutationWatcher();
      if (scrollController) {
        scrollController.stop();
        scrollController = null;
      }

      currentMode = payload.mode ?? 'manual';
      targetCount =
        typeof payload.targetCount === 'number' && payload.targetCount > 0
          ? payload.targetCount
          : 100;
      duplicateDetection = payload.scroll?.duplicateDetection ?? true;

      collectedProducts = [];
      parseCache.clear();
      dedup.clear();
      dedup.setEnabled(duplicateDetection);

      if (
        duplicateDetection &&
        Array.isArray(payload.existingAsins) &&
        payload.existingAsins.length > 0
      ) {
        dedup.seed(payload.existingAsins);
      }

      isCollecting = true;
      const initialTotal = runScrapeBatch(true);

      if (!isCollecting || initialTotal >= targetCount) {
        return;
      }

      const pageType = detectAmazonPageType(window.location.href, document);
      if (pageType === 'product-detail') {
        finishCollection('page_end');
        return;
      }

      if (currentMode === 'automatic') {
        scrollController = new ScrollController({
          scrollAmount: payload.scroll?.scrollAmount ?? 800,
          scrollInterval: payload.scroll?.scrollInterval ?? 500,
          waitAfterScroll: payload.scroll?.waitAfterScroll ?? 1500,
          maxWaitForNew: 5000,
          maxLoadingWait: 15000,
        });

        scrollController.start(
          () => {
            if (!isCollecting) return;
            runScrapeBatch(false);
          },
          () => {
            if (isCollecting) {
              runScrapeBatch(false);
              if (isCollecting) {
                finishCollection('page_end');
              }
            }
          },
          () => isCollecting && getReportedTotal() < targetCount,
          () => countProductCards(document),
          () => hasActiveLoadingIndicator(document),
        );
      } else {
        startMutationWatcher();
      }
    };

    const handleCommand = (
      message: unknown,
      sendResponse?: (res?: unknown) => void,
    ): boolean => {
      if (!message || typeof message !== 'object') return false;
      const msg = message as { type?: string; payload?: unknown };

      if (msg.type === 'PING_CONTENT_SCRIPT') {
        sendResponse?.({ ok: true, url: window.location.href });
        return false;
      }

      if (msg.type === 'HIDE_PAGE_OVERLAY') {
        document.getElementById('pphunt-extension-overlay-host')?.remove();
        sendResponse?.({ ok: true });
        return false;
      }

      const outcome = validateExtensionMessage(message);
      if (outcome.status === 'invalid') {
        console.warn(
          '[PPHunt] Invalid content message rejected:',
          outcome.issues,
        );
        sendResponse?.({ ok: false, error: 'INVALID_MESSAGE' });
        return false;
      }
      if (outcome.status === 'unknown') {
        return false;
      }

      const validMsg = outcome.message;

      switch (validMsg.type) {
        case 'COLLECT_PRODUCTS':
          sendResponse?.({ ok: true });
          handleCollectProducts(
            validMsg.payload as CollectProductsCommandPayload,
          );
          break;

        case 'PAUSE_SCROLLING':
          sendResponse?.({ ok: true });
          scrollController?.pause();
          break;

        case 'SAVE_CONTEXT_PRODUCT':
          sendResponse?.({ ok: true });
          handleSaveContextProduct();
          break;

        case 'SAVE_JOB_UPDATE':
          sendResponse?.({ ok: true });
          handleSaveJobUpdate(validMsg.payload);
          break;

        case 'STOP_COLLECTION_CMD':
        case 'STOP_COLLECTION':
          sendResponse?.({ ok: true });
          finishCollection('manual_stop');
          break;

        case 'RESUME_SCROLLING':
          sendResponse?.({ ok: true });
          isCollecting = true;
          if (scrollController) {
            scrollController.resume();
          } else if (currentMode === 'manual') {
            runScrapeBatch(false);
            startMutationWatcher();
          } else {
            runScrapeBatch(false);
          }
          break;

        default:
          break;
      }

      return false;
    };

    const runtimeListener = (
      message: unknown,
      _sender: unknown,
      sendResponse?: (res?: unknown) => void,
    ) => {
      return handleCommand(message, sendResponse);
    };

    const domBridgeListener = (event: Event) => {
      const customEvent = event as CustomEvent<unknown>;
      if (customEvent.detail) {
        handleCommand(customEvent.detail);
      }
    };

    const handleNavigationChange = () => {
      if (window.location.href !== lastKnownUrl) {
        lastKnownUrl = window.location.href;
        parseCache.clear();
        reportPageInfo();
      }
    };

    const rememberSaveTarget = (event: Event) => {
      lastSaveCapture = captureSaveTarget(event);
    };

    // Capture phase + passive: the page's own context-menu handlers may stop
    // propagation, but they cannot stop a capturing listener.
    document.addEventListener('contextmenu', rememberSaveTarget, {
      capture: true,
      passive: true,
    });
    document.addEventListener('mousedown', rememberSaveTarget, {
      capture: true,
      passive: true,
    });

    // Per-card control: listing pages only - a product-detail page has no card,
    // and the right-click entry covers that page.
    if (detectAmazonPageType(window.location.href, document) !== 'product-detail') {
      cardActionLayer = createCardActionLayer({
        onSave: ({ card, asin, jobId }) => {
          const pageUrl = window.location.href;
          const product = extractProductFromCard(card, pageUrl);

          if (!product) {
            cardActionLayer?.applyJobUpdate({
              jobId,
              asin,
              state: 'failed',
              message: 'No product found here',
            });
            return;
          }

          sendRuntimeMessageSafe({
            type: 'SAVE_PRODUCT',
            payload: {
              jobId,
              product,
              context: buildSaveContext(card, pageUrl, 'card-button'),
            },
          });
        },
      });
      cardActionLayer.start();
    }

    browser.runtime.onMessage.addListener(runtimeListener);
    window.addEventListener('pphunt:command', domBridgeListener);
    window.addEventListener('popstate', handleNavigationChange);
    window.addEventListener('hashchange', handleNavigationChange);

    reportPageInfo();

    win.__PPHUNT_CONTENT_CLEANUP__ = () => {
      isCollecting = false;
      debouncedManualScrape.cancel();
      stopMutationWatcher();
      if (scrollController) {
        scrollController.stop();
        scrollController = null;
      }
      try {
        browser.runtime.onMessage.removeListener?.(runtimeListener);
      } catch {
        // Ignore
      }
      document.removeEventListener('contextmenu', rememberSaveTarget, {
        capture: true,
      });
      document.removeEventListener('mousedown', rememberSaveTarget, {
        capture: true,
      });
      removeSaveToast();
      collectionChoiceQueue.close();
      cardActionLayer?.stop();
      cardActionLayer = null;
      window.removeEventListener('pphunt:command', domBridgeListener);
      window.removeEventListener('popstate', handleNavigationChange);
      window.removeEventListener('hashchange', handleNavigationChange);
    };
  },
});
