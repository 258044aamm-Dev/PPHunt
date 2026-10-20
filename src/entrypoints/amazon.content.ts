import { AMAZON_MATCH_PATTERNS } from '@/engines/amazon/constants/match-patterns';
import {
  createCardActionLayer,
  type CardActionJobUpdate,
} from '@/engines/amazon/content/card-action-layer';
import {
  buildSaveContext,
  extractProductFromCard,
  resolveSaveCandidate,
  saveMissMessage,
} from '@/engines/amazon/content/save-product';
import { createCollectionChoiceQueue } from '@/engines/amazon/content/collection-choice-dialog';
import { captureSaveTarget, type CapturedSaveTarget } from '@/engines/amazon/content/save-target';
import { removeSaveToast, showSaveToast } from '@/engines/amazon/content/toast';
import { syncCardActionTheme } from '@/engines/amazon/content/card-action-theme';
import {
  getDiagnosticsEnabled,
  refreshDiagnosticsEnabled,
  subscribeDiagnosticsEnabled,
} from '@/engines/amazon/utils/diagnostics-flag';
import { createSingleReportSink } from '@/engines/amazon/scraper/card-diagnostics';
import { createCollectionDiagnosticsRun } from '@/engines/amazon/content/collection-diagnostics';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';
import { validateExtensionMessage } from '@/engines/amazon/schemas/validate-message';
import { ScrollController } from '@/lib/scraper/scroll-controller';
import {
  AmazonDeduplicationEngine,
  AmazonParseCache,
  countProductCards,
  createChurnResistantDebounce,
  createFieldDiagnosticsCollector,
  defaultAmazonDriftTelemetry,
  detectAmazonPageType,
  detectPageIssues,
  extractAmazonSearchQuery,
  hasActiveLoadingIndicator,
  parseAmazonCategoryPage,
  parseAmazonProductDetail,
  parseAmazonSearchResults,
  setDriftTransport,
  type ExtractionDiagnosticsSink,
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
  // SAD-369 step 3: present only when the diagnostics switch is on. Every
  // listing branch forwards it; a missed branch just logs nothing.
  diagnosticsSink?: ExtractionDiagnosticsSink,
): ScrapedAmazonProduct[] {
  const pageType = detectAmazonPageType(url, doc);

  if (pageType === 'product-detail') {
    // SAD-369 step 3 (G10): a collection started on a product page reports
    // too — it currently parses without a collector and logs nothing at all.
    // The parser records the ASIN and reconciles validation internally, so
    // `build()` is all that is left here (same shape as the PDP save path).
    const diagnostics = diagnosticsSink
      ? createFieldDiagnosticsCollector()
      : undefined;
    const detail = parseAmazonProductDetail(doc, url, diagnostics);
    if (diagnostics && detail) {
      diagnosticsSink?.accept(diagnostics.build());
    }
    return detail ? [detail] : [];
  }

  if (pageType === 'search') {
    const searchItems = parseAmazonSearchResults(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
      ...(diagnosticsSink ? { diagnosticsSink } : {}),
    });
    if (searchItems.length > 0) return searchItems;
    return parseAmazonCategoryPage(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
      ...(diagnosticsSink ? { diagnosticsSink } : {}),
    });
  }

  if (pageType === 'bestsellers' || pageType === 'category') {
    const categoryItems = parseAmazonCategoryPage(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
      ...(diagnosticsSink ? { diagnosticsSink } : {}),
    });
    if (categoryItems.length > 0) return categoryItems;
    return parseAmazonSearchResults(doc, url, {
      cache,
      telemetry: defaultAmazonDriftTelemetry,
      ...(diagnosticsSink ? { diagnosticsSink } : {}),
    });
  }

  // Fallback for unclassified Amazon pages that still contain product cards
  const searchFallback = parseAmazonSearchResults(doc, url, {
    cache,
    telemetry: defaultAmazonDriftTelemetry,
    ...(diagnosticsSink ? { diagnosticsSink } : {}),
  });
  if (searchFallback.length > 0) return searchFallback;

  return parseAmazonCategoryPage(doc, url, {
    cache,
    telemetry: defaultAmazonDriftTelemetry,
    ...(diagnosticsSink ? { diagnosticsSink } : {}),
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
    // SAD-369 step 3: per-run collection diagnostics — the 50-item cap (D7)
    // and the exactly-once delivery rule (D11) live in this module state.
    const collectionDiagnostics = createCollectionDiagnosticsRun();
    const dedup = new AmazonDeduplicationEngine();
    const parseCache = new AmazonParseCache();
    let scrollController: ScrollController | null = null;
    let mutationObserver: MutationObserver | null = null;
    /** SAD-331: removes the theme listener; null on product-detail pages. */
    let stopCardActionThemeSync: (() => void) | null = null;
    /** SAD-369: removes the diagnostics-flag listener on cleanup. */
    let stopDiagnosticsSync: (() => void) | null = null;
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
    const handleSaveContextProduct = async (options: { fromSubframe?: boolean } = {}) => {
      // SAD-369: resolve the diagnostics switch before the parse, so the
      // first save of a session is never skipped by the startup read race.
      await refreshDiagnosticsEnabled();
      const pageUrl = window.location.href;
      const candidate = resolveSaveCandidate({
        capture: lastSaveCapture,
        pageUrl,
        triggeredBy: 'context-menu',
      });

      if (!candidate) {
        showSaveToast({
          state: 'failed',
          message: saveMissMessage({ fromSubframe: options.fromSubframe }),
        });
        return;
      }

      const jobId = mintSaveJobId();
      pendingSaveJobId = jobId;
      sendRuntimeMessageSafe({
        type: 'SAVE_PRODUCT',
        payload: {
          jobId,
          product: candidate.product,
          context: candidate.context,
          // SAD-359: PDP-parse diagnostics ride along for the worker to log.
          ...(candidate.extractionDiagnostics
            ? { extractionDiagnostics: candidate.extractionDiagnostics }
            : {}),
        },
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
        // SAD-369 step 3: the run sink only while the switch is on. Saves
        // never touch this sink (D8) — they use their own single-report sink.
        getDiagnosticsEnabled() ? collectionDiagnostics.sink : undefined,
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
          // SAD-369 step 3 (D11): only the reports not yet sent this run
          // ride along — an `updatedExisting` batch re-sends the whole run,
          // and products past the cap have no report, so a parallel array
          // would re-log products and could never validate.
          const extractionDiagnostics =
            collectionDiagnostics.takeUnsentFor(batchToEmit);
          sendRuntimeMessageSafe({
            type: 'PRODUCTS_COLLECTED',
            payload: {
              products: batchToEmit,
              totalCount: totalReported,
              isNewBatch,
              ...(extractionDiagnostics.length > 0
                ? { extractionDiagnostics }
                : {}),
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

    const handleCollectProducts = async (payload: CollectProductsCommandPayload) => {
      // SAD-369: resolve the diagnostics switch before the first scrape batch,
      // so the first collection of a session is never skipped by the startup
      // read race (plan R7).
      await refreshDiagnosticsEnabled();
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
      // SAD-369 step 3 (T26): this is the run boundary — a new collection
      // resets the cap counter and the report maps.
      collectionDiagnostics.reset();
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
          void handleCollectProducts(
            validMsg.payload as CollectProductsCommandPayload,
          );
          break;

        case 'PAUSE_SCROLLING':
          sendResponse?.({ ok: true });
          scrollController?.pause();
          break;

        case 'SAVE_CONTEXT_PRODUCT':
          sendResponse?.({ ok: true });
          void handleSaveContextProduct({
            fromSubframe: validMsg.payload.fromSubframe === true,
          });
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
        onSave: async ({ card, asin, jobId }) => {
          // SAD-369: resolve the diagnostics switch before the parse, so the
          // first card-icon save is never skipped by the startup read race.
          await refreshDiagnosticsEnabled();
          const pageUrl = window.location.href;
          // SAD-369 step 2 (D5): the card-icon save carries its own per-field
          // report — opt-in, like every other diagnostics site.
          const sink = getDiagnosticsEnabled()
            ? createSingleReportSink()
            : undefined;
          const product = extractProductFromCard(
            card,
            pageUrl,
            sink ? { diagnosticsSink: sink } : {},
          );

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
              ...(sink?.report
                ? { extractionDiagnostics: sink.report }
                : {}),
            },
          });
        },
      });
      // SAD-331: the control has its own shadow palette, so it follows the
      // stored theme rather than the page or the OS.
      stopCardActionThemeSync = syncCardActionTheme(cardActionLayer);
      cardActionLayer.start();
    }

    // SAD-369: the diagnostics switch cache — read once, then kept in sync by
    // storage.onChanged so flipping the setting in Settings takes effect on
    // this page without a reload. Fails closed until the read resolves.
    void refreshDiagnosticsEnabled();
    stopDiagnosticsSync = subscribeDiagnosticsEnabled();

    // SAD-369 D10: the drift line is printed by the service worker, not the
    // page console — the worker is where the other diagnostics lines live,
    // and an Amazon page's console is not the owner's console. The worker
    // gates the print; the transport only routes counts (C2).
    setDriftTransport((payload) => {
      sendRuntimeMessageSafe({ type: 'DRIFT_REPORT', payload });
    });

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
      stopCardActionThemeSync?.();
      stopCardActionThemeSync = null;
      stopDiagnosticsSync?.();
      stopDiagnosticsSync = null;
      // SAD-369 D10: restore the default page-console transport so a remount
      // (or a test) never leaves a stale message-sending transport behind.
      setDriftTransport(null);
      cardActionLayer?.stop();
      cardActionLayer = null;
      window.removeEventListener('pphunt:command', domBridgeListener);
      window.removeEventListener('popstate', handleNavigationChange);
      window.removeEventListener('hashchange', handleNavigationChange);
    };
  },
});
