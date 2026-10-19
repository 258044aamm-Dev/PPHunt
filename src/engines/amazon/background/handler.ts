import {
  DEFAULT_AMAZON_SETTINGS,
  MAX_SEEDED_ASINS,
  clampTargetCount,
} from '../constants/defaults';
import {
  addHistoryEntry,
  addProducts,
  clearActiveSession,
  createSession,
  ensureSession,
  getActiveSession,
  getExistingASINs,
  getSession,
  getSettings,
  readActiveSession,
  updateSessionStatus,
  writeActiveSession,
  type ActiveSessionPointer,
} from '../db';
import { ProductSchema } from '../schemas/product';
import { ScrapedProductSchema } from '../schemas/scraped-product';
import { validateExtensionMessage } from '../schemas/validate-message';
import { detectAmazonPageType } from '../scraper/page-detector';
import { validateAndNormalizeScrapedProduct } from '../scraper/field-parsers';
import type {
  AmazonCollectionStatus,
  CollectionMode,
  ScrapedProduct,
  ScrollRuntimeSettingsPayload,
} from '../types';
import { isAmazonUrl } from '../utils/amazon-url';
import { handleSaveProduct } from './save-job';

interface ActiveCollectionRuntimeState {
  tabId: number;
  sessionKey: string;
  mode: CollectionMode;
  targetCount: number;
  startedAt: string;
  url: string;
  lastCollectedCount: number;
}

const TRANSIENT_MV3_CHANNEL_CLOSED_REGEX =
  /A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received/i;

function broadcastRuntimeMessage(message: Record<string, unknown>): void {
  try {
    const result = browser.runtime.sendMessage(message);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {
        // Ignore when sidepanel / overlay is closed
      });
    }
  } catch {
    // Ignore synchronous errors
  }
}

async function resolveTabUrl(
  tabId: number,
  fallbackUrl = 'https://www.amazon.com',
): Promise<string> {
  try {
    const tabsApi = browser.tabs as unknown as {
      get?: (id: number) => Promise<{ url?: string }>;
    };
    if (typeof tabsApi?.get === 'function') {
      const tab = await tabsApi.get(tabId);
      if (tab?.url) return tab.url;
    }
  } catch {
    // Ignore tab lookup failure
  }
  return fallbackUrl;
}

async function resolveScrollRuntimeSettings(): Promise<ScrollRuntimeSettingsPayload> {
  try {
    const settings = await getSettings();
    return {
      scrollAmount: settings.scrollSpeed,
      scrollInterval: settings.scrollInterval,
      waitAfterScroll: settings.waitAfterScroll,
      duplicateDetection: settings.duplicateDetection,
    };
  } catch {
    return {
      scrollAmount: DEFAULT_AMAZON_SETTINGS.scrollSpeed,
      scrollInterval: DEFAULT_AMAZON_SETTINGS.scrollInterval,
      waitAfterScroll: DEFAULT_AMAZON_SETTINGS.waitAfterScroll,
      duplicateDetection: DEFAULT_AMAZON_SETTINGS.duplicateDetection,
    };
  }
}

/**
 * Dispatches a command to the Amazon content script in `tabId`.
 * 1. Tries `browser.tabs.sendMessage(tabId, command)`.
 * 2. Ignores benign MV3 async channel-close warnings.
 * 3. On disconnection, attempts to re-inject `/content-scripts/amazon.js` and retries `tabs.sendMessage`.
 * 4. If `tabs.sendMessage` or file re-injection fails, still attempts the `executeScript` DOM event bridge (`H-2`).
 */
export async function dispatchToAmazonTab(
  tabId: number,
  command: Record<string, unknown>,
): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, command);
    return true;
  } catch (firstErr) {
    const firstMsg =
      firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (TRANSIENT_MV3_CHANNEL_CLOSED_REGEX.test(firstMsg)) {
      return true;
    }

    const scriptingApi = (
      browser as unknown as {
        scripting?: {
          executeScript?: (opts: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).scripting;

    if (typeof scriptingApi?.executeScript === 'function') {
      try {
        await scriptingApi.executeScript({
          target: { tabId },
          files: ['/content-scripts/amazon.js'],
        });
      } catch {
        // Proceed to retry & DOM bridge even if file injection failed (H-2)
      }

      try {
        await browser.tabs.sendMessage(tabId, command);
        return true;
      } catch (secondErr) {
        const secondMsg =
          secondErr instanceof Error ? secondErr.message : String(secondErr);
        if (TRANSIENT_MV3_CHANNEL_CLOSED_REGEX.test(secondMsg)) {
          return true;
        }
      }

      // DOM Event Bridge fallback (H-2 / SAD-165)
      try {
        await scriptingApi.executeScript({
          target: { tabId },
          func: (dispatchedCmd: unknown) => {
            window.dispatchEvent(
              new CustomEvent('pphunt:command', { detail: dispatchedCmd }),
            );
            return { ok: true };
          },
          args: [command],
        });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

export interface AmazonBackgroundController {
  handleMessage: (
    rawMessage: unknown,
    sender?: { tab?: { id?: number; url?: string } },
    sendResponse?: (response?: unknown) => void,
  ) => boolean;
  handleTabRemoved: (tabId: number) => void;
  handleTabUpdated: (
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab?: { id?: number; url?: string },
  ) => void;
  handleTabActivated: (activeInfo: { tabId: number }) => void;
}

/**
 * Creates a clean-slate Amazon background controller managing collection lifecycle,
 * MV3 worker-restart survival via `storage.session` + IndexedDB fallback, and
 * strict runtime schema validation.
 */
export function createAmazonBackgroundController(): AmazonBackgroundController {
  let activeCollection: ActiveCollectionRuntimeState | null = null;
  let pendingProductsChain: Promise<void> = Promise.resolve();
  const finalizedSessionKeys = new Set<string>();
  let lastFinalizedSession: ActiveCollectionRuntimeState | null = null;

  const hydrateActiveCollection =
    async (): Promise<ActiveCollectionRuntimeState | null> => {
      if (activeCollection) {
        return activeCollection;
      }

      const pointer = await readActiveSession();
      if (pointer) {
        activeCollection = {
          tabId: pointer.tabId,
          sessionKey: pointer.sessionKey,
          mode: pointer.mode,
          targetCount: pointer.targetCount,
          startedAt: pointer.startedAt,
          url: pointer.url,
          lastCollectedCount: pointer.lastCollectedCount ?? 0,
        };
        return activeCollection;
      }

      const dbSession = await getActiveSession();
      if (dbSession) {
        activeCollection = {
          tabId: dbSession.tabId,
          sessionKey: dbSession.id,
          mode: dbSession.mode,
          targetCount: dbSession.targetCount,
          startedAt: dbSession.startedAt,
          url: dbSession.url,
          lastCollectedCount: dbSession.collectedCount,
        };
        return activeCollection;
      }

      return null;
    };

  const persistPointer = async (
    state: ActiveCollectionRuntimeState,
  ): Promise<void> => {
    const pointer: ActiveSessionPointer = {
      tabId: state.tabId,
      sessionKey: state.sessionKey,
      mode: state.mode,
      targetCount: state.targetCount,
      startedAt: state.startedAt,
      url: state.url,
      lastCollectedCount: state.lastCollectedCount,
    };
    await writeActiveSession(pointer);
  };

  const startOrRetryCollection = async (
    payload: {
      mode: CollectionMode;
      targetCount: number;
      tabId: number;
      sessionKey?: string;
    },
    reloadFirst: boolean,
  ): Promise<void> => {
    const { mode, tabId } = payload;
    const targetCount = clampTargetCount(payload.targetCount);
    const tabUrl = await resolveTabUrl(tabId);
    const nowIso = new Date().toISOString();

    let sessionKey: string;
    let startedAt = nowIso;

    if (payload.sessionKey) {
      sessionKey = await ensureSession(
        payload.sessionKey,
        tabId,
        tabUrl,
        mode,
        targetCount,
        nowIso,
      );
      const row = await getSession(sessionKey);
      if (row?.startedAt) {
        startedAt = row.startedAt;
      }
    } else {
      sessionKey = await createSession(tabId, tabUrl, mode, targetCount);
      const row = await getSession(sessionKey);
      if (row?.startedAt) {
        startedAt = row.startedAt;
      }
    }

    const existingAsins = await getExistingASINs(sessionKey, MAX_SEEDED_ASINS);
    const scrollSettings = await resolveScrollRuntimeSettings();

    finalizedSessionKeys.delete(sessionKey);
    lastFinalizedSession = null;

    activeCollection = {
      tabId,
      sessionKey,
      mode,
      targetCount,
      startedAt,
      url: tabUrl,
      lastCollectedCount: existingAsins.length,
    };

    await persistPointer(activeCollection);

    if (reloadFirst) {
      try {
        const tabsApi = browser.tabs as unknown as {
          reload?: (id: number) => Promise<void>;
        };
        if (typeof tabsApi?.reload === 'function') {
          await tabsApi.reload(tabId);
        }
      } catch {
        // Ignore reload error
      }
    }

    const delivered = await dispatchToAmazonTab(tabId, {
      type: 'COLLECT_PRODUCTS',
      payload: {
        mode,
        targetCount,
        scroll: scrollSettings,
        existingAsins,
      },
    });

    if (!delivered) {
      const errMsg =
        'PPHunt lost its communication channel with the Amazon page helper script.';
      await updateSessionStatus(sessionKey, 'error', undefined, errMsg);
      broadcastRuntimeMessage({
        type: 'UPDATE_PROGRESS',
        payload: {
          collected: activeCollection.lastCollectedCount,
          target: targetCount,
          status: 'error',
          error: errMsg,
          sessionKey,
        },
      });
    }
  };

  const handlePauseCollection = async (tabId: number): Promise<void> => {
    const active = await hydrateActiveCollection();
    const sessionKey = active?.sessionKey ?? `${tabId}_${Date.now()}`;
    await updateSessionStatus(sessionKey, 'paused');
    await dispatchToAmazonTab(tabId, { type: 'PAUSE_SCROLLING' });
    broadcastRuntimeMessage({
      type: 'UPDATE_PROGRESS',
      payload: {
        collected: active?.lastCollectedCount ?? 0,
        target: active?.targetCount ?? 50,
        status: 'paused',
        error: null,
        sessionKey,
      },
    });
  };

  const handleResumeCollection = async (tabId: number): Promise<void> => {
    const active = await hydrateActiveCollection();
    const sessionKey = active?.sessionKey ?? `${tabId}_${Date.now()}`;
    await updateSessionStatus(sessionKey, 'collecting');
    await dispatchToAmazonTab(tabId, { type: 'RESUME_SCROLLING' });
    broadcastRuntimeMessage({
      type: 'UPDATE_PROGRESS',
      payload: {
        collected: active?.lastCollectedCount ?? 0,
        target: active?.targetCount ?? 50,
        status: 'collecting',
        error: null,
        sessionKey,
      },
    });
  };

  const handleStopCollection = async (tabId: number): Promise<void> => {
    await pendingProductsChain;
    const active = await hydrateActiveCollection();
    await dispatchToAmazonTab(tabId, { type: 'STOP_COLLECTION_CMD' });

    if (active) {
      finalizedSessionKeys.add(active.sessionKey);
      lastFinalizedSession = { ...active };
      const completedAt = new Date().toISOString();
      await updateSessionStatus(active.sessionKey, 'completed', {
        collected: active.lastCollectedCount,
        target: active.targetCount,
      });
      await addHistoryEntry({
        sessionKey: active.sessionKey,
        url: active.url || 'https://www.amazon.com',
        mode: active.mode,
        targetCount: active.targetCount,
        collectedCount: active.lastCollectedCount,
        startedAt: active.startedAt,
        completedAt,
        status: 'completed',
      });
    }

    activeCollection = null;
    await clearActiveSession();
  };

  const processProductsCollected = async (
    payload: {
      products: unknown[];
      totalCount: number;
      isNewBatch: boolean;
    },
    senderUrl?: string,
  ): Promise<void> => {
    let active = await hydrateActiveCollection();
    if (!active && lastFinalizedSession) {
      active = lastFinalizedSession;
    }
    if (!active) {
      const nowIso = new Date().toISOString();
      const fallbackUrl = senderUrl ?? 'https://www.amazon.com';
      const fallbackKey = await createSession(0, fallbackUrl, 'manual', 50);
      active = {
        tabId: 0,
        sessionKey: fallbackKey,
        mode: 'manual',
        targetCount: 50,
        startedAt: nowIso,
        url: fallbackUrl,
        lastCollectedCount: 0,
      };
      activeCollection = active;
    }

    const isSessionFinalized = finalizedSessionKeys.has(active.sessionKey);

    if (
      senderUrl &&
      (!active.url || active.url === 'https://www.amazon.com')
    ) {
      active.url = senderUrl;
    }

    const rawProducts = Array.isArray(payload.products) ? payload.products : [];
    const validProducts: ScrapedProduct[] = [];
    const rejectedDetails: Array<{ asin: string; issues: string }> = [];
    const nowIso = new Date().toISOString();

    for (const raw of rawProducts) {
      const rec =
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : {};
      const rawAsin = typeof rec.asin === 'string' ? rec.asin : 'UNKNOWN';

      const normalized = validateAndNormalizeScrapedProduct(
        rec as Partial<ScrapedProduct>,
        senderUrl ?? active.url,
      );
      if (!normalized) {
        rejectedDetails.push({
          asin: rawAsin,
          issues: 'Failed scraped product normalization',
        });
        continue;
      }

      const candidateProduct = {
        ...normalized,
        collectedAt:
          typeof rec.collectedAt === 'string' ? rec.collectedAt : nowIso,
        sessionKey: active.sessionKey,
      };

      const productParsed = ProductSchema.safeParse(candidateProduct);
      if (!productParsed.success) {
        rejectedDetails.push({
          asin: normalized.asin,
          issues: productParsed.error.issues
            .map((iss) => `${iss.path.join('.') || 'root'}: ${iss.message}`)
            .join('; '),
        });
        continue;
      }

      const scrapedCheck = ScrapedProductSchema.safeParse(normalized);
      if (scrapedCheck.success) {
        validProducts.push(scrapedCheck.data);
      }
    }

    const rejected = rejectedDetails.length;
    const rejectedOf = rawProducts.length;

    if (rejected > 0) {
      console.warn(
        `[PPHunt] ProductSchema rejected ${rejected}/${rejectedOf} products in batch:`,
        rejectedDetails,
      );
    }

    if (rawProducts.length > 0 && validProducts.length === 0) {
      return;
    }

    if (validProducts.length > 0) {
      await addProducts(validProducts, active.sessionKey);
    }

    active.lastCollectedCount = Math.max(
      active.lastCollectedCount,
      payload.totalCount,
    );

    // Never overwrite a completed/stopped session back to 'collecting'
    if (isSessionFinalized || finalizedSessionKeys.has(active.sessionKey)) {
      return;
    }

    await persistPointer(active);
    await updateSessionStatus(active.sessionKey, 'collecting', {
      collected: active.lastCollectedCount,
      target: active.targetCount,
    });

    broadcastRuntimeMessage({
      type: 'UPDATE_PROGRESS',
      payload: {
        collected: active.lastCollectedCount,
        target: active.targetCount,
        status: 'collecting',
        error: null,
        sessionKey: active.sessionKey,
        ...(rejected > 0 ? { rejected, rejectedOf } : {}),
      },
    });
  };

  const handleProductsCollected = (
    payload: {
      products: unknown[];
      totalCount: number;
      isNewBatch: boolean;
    },
    senderUrl?: string,
  ): Promise<void> => {
    const next = pendingProductsChain.then(
      () => processProductsCollected(payload, senderUrl),
      () => processProductsCollected(payload, senderUrl),
    );
    pendingProductsChain = next.catch(() => {});
    return next;
  };

  const handleCollectionProgress = async (payload: {
    collected: number;
    target: number;
    status: AmazonCollectionStatus;
  }): Promise<void> => {
    await pendingProductsChain;
    const active = await hydrateActiveCollection();
    if (
      !active &&
      lastFinalizedSession &&
      payload.status === 'collecting'
    ) {
      // Ignore late 'collecting' progress arriving after session completion
      return;
    }
    const sessionKey =
      active?.sessionKey ??
      lastFinalizedSession?.sessionKey ??
      `0_${Date.now()}`;
    if (
      finalizedSessionKeys.has(sessionKey) &&
      payload.status === 'collecting'
    ) {
      return;
    }
    const effectiveTarget = active?.targetCount ?? clampTargetCount(payload.target);
    const effectiveMode = active?.mode ?? 'manual';
    const effectiveStartedAt = active?.startedAt ?? new Date().toISOString();
    const effectiveUrl = active?.url ?? 'https://www.amazon.com';
    const effectiveCollected = active
      ? Math.max(active.lastCollectedCount, payload.collected)
      : payload.collected;

    if (active) {
      active.lastCollectedCount = effectiveCollected;
    }

    await updateSessionStatus(sessionKey, payload.status, {
      collected: effectiveCollected,
      target: effectiveTarget,
    });

    if (payload.status === 'completed') {
      finalizedSessionKeys.add(sessionKey);
      if (active) {
        lastFinalizedSession = { ...active };
      }
      await addHistoryEntry({
        sessionKey,
        url: effectiveUrl,
        mode: effectiveMode,
        targetCount: effectiveTarget,
        collectedCount: effectiveCollected,
        startedAt: effectiveStartedAt,
        completedAt: new Date().toISOString(),
        status: 'completed',
      });
      activeCollection = null;
      await clearActiveSession();
    } else if (active) {
      await persistPointer(active);
    }

    broadcastRuntimeMessage({
      type: 'UPDATE_PROGRESS',
      payload: {
        collected: effectiveCollected,
        target: effectiveTarget,
        status: payload.status,
        error: null,
        sessionKey,
      },
    });
  };

  const handleContentError = async (
    message: string,
    collectedSoFar?: number,
  ): Promise<void> => {
    const active = await hydrateActiveCollection();
    const sessionKey = active?.sessionKey ?? `0_${Date.now()}`;
    const collected =
      collectedSoFar ?? active?.lastCollectedCount ?? 0;
    const target = active?.targetCount ?? 50;

    await updateSessionStatus(
      sessionKey,
      'error',
      { collected, target },
      message,
    );

    broadcastRuntimeMessage({
      type: 'UPDATE_PROGRESS',
      payload: {
        collected,
        target,
        status: 'error',
        error: message,
        sessionKey,
      },
    });
  };

  const handleMessage = (
    rawMessage: unknown,
    sender?: { tab?: { id?: number; url?: string } },
    sendResponse?: (response?: unknown) => void,
  ): boolean => {
    // Handle legacy content-script COLLECTION_COMPLETE / COLLECTION_ERROR / PAGE_INFO messages
    if (rawMessage && typeof rawMessage === 'object') {
      const candidate = rawMessage as {
        type?: string;
        payload?: Record<string, unknown>;
      };

      if (candidate.type === 'COLLECTION_COMPLETE' && candidate.payload) {
        const totalCollected =
          typeof candidate.payload.totalCollected === 'number'
            ? candidate.payload.totalCollected
            : 0;
        void handleCollectionProgress({
          collected: totalCollected,
          target: activeCollection?.targetCount ?? 50,
          status: 'completed',
        });
        sendResponse?.({ ok: true });
        return false;
      }

      if (candidate.type === 'COLLECTION_ERROR' && candidate.payload) {
        const errText =
          typeof candidate.payload.error === 'string'
            ? candidate.payload.error
            : 'Collection error';
        const collectedSoFar =
          typeof candidate.payload.collectedSoFar === 'number'
            ? candidate.payload.collectedSoFar
            : undefined;
        void handleContentError(errText, collectedSoFar);
        sendResponse?.({ ok: true });
        return false;
      }

      if (candidate.type === 'PAGE_INFO') {
        return false;
      }

      if (candidate.type === 'PRODUCTS_COLLECTED') {
        const p = candidate.payload;
        if (
          !p ||
          typeof p !== 'object' ||
          !Array.isArray(p.products) ||
          typeof p.totalCount !== 'number' ||
          !Number.isInteger(p.totalCount) ||
          p.totalCount < 0 ||
          typeof p.isNewBatch !== 'boolean'
        ) {
          console.warn(
            '[PPHunt] Rejected invalid PRODUCTS_COLLECTED envelope',
          );
          sendResponse?.({ ok: false, error: 'INVALID_MESSAGE' });
          return false;
        }

        sendResponse?.({ ok: true });
        void handleProductsCollected(
          {
            products: p.products as unknown[],
            totalCount: p.totalCount,
            isNewBatch: p.isNewBatch,
          },
          sender?.tab?.url,
        );
        return false;
      }
    }

    const outcome = validateExtensionMessage(rawMessage);
    if (outcome.status === 'unknown') {
      return false;
    }
    if (outcome.status === 'invalid') {
      console.warn(
        '[PPHunt] Rejected invalid extension message:',
        outcome.issues,
      );
      sendResponse?.({ ok: false, error: 'INVALID_MESSAGE' });
      return false;
    }

    const validated = outcome.message;

    switch (validated.type) {
      case 'START_COLLECTION':
        sendResponse?.({ ok: true });
        void startOrRetryCollection(validated.payload, false);
        break;

      case 'RELOAD_AND_RETRY_COLLECTION':
        sendResponse?.({ ok: true });
        void startOrRetryCollection(validated.payload, true);
        break;

      case 'PAUSE_COLLECTION':
        sendResponse?.({ ok: true });
        void handlePauseCollection(validated.payload.tabId);
        break;

      case 'RESUME_COLLECTION':
        sendResponse?.({ ok: true });
        void handleResumeCollection(validated.payload.tabId);
        break;

      case 'STOP_COLLECTION':
        sendResponse?.({ ok: true });
        void handleStopCollection(validated.payload.tabId);
        break;

      case 'PRODUCTS_COLLECTED':
        sendResponse?.({ ok: true });
        void handleProductsCollected(validated.payload, sender?.tab?.url);
        break;

      case 'COLLECTION_PROGRESS':
        sendResponse?.({ ok: true });
        void handleCollectionProgress(validated.payload);
        break;

      case 'SAVE_PRODUCT':
        sendResponse?.({ ok: true });
        void handleSaveProduct(validated.payload, {
          emit: (update) => {
            const message = { type: 'SAVE_JOB_UPDATE', payload: update };
            if (typeof sender?.tab?.id === 'number') {
              void dispatchToAmazonTab(sender.tab.id, message);
            }
            broadcastRuntimeMessage(message);
          },
        });
        break;

      case 'CONTENT_ERROR':
        sendResponse?.({ ok: true });
        void handleContentError(validated.payload.message);
        break;

      default:
        return false;
    }

    return false;
  };

  const handleTabRemoved = (tabId: number): void => {
    void (async () => {
      const active = await hydrateActiveCollection();
      if (!active || active.tabId !== tabId) return;

      const errMsg = 'The Amazon tab was closed during collection.';
      await updateSessionStatus(
        active.sessionKey,
        'interrupted',
        {
          collected: active.lastCollectedCount,
          target: active.targetCount,
        },
        errMsg,
      );

      activeCollection = null;
      await clearActiveSession();

      broadcastRuntimeMessage({
        type: 'UPDATE_PROGRESS',
        payload: {
          collected: active.lastCollectedCount,
          target: active.targetCount,
          status: 'error',
          error: errMsg,
          sessionKey: active.sessionKey,
        },
      });
    })();
  };

  const handleTabUpdated = (
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab?: { id?: number; url?: string },
  ): void => {
    const url = changeInfo.url ?? tab?.url;
    if (!url) return;

    const isAmazon = isAmazonUrl(url);
    const pageType = isAmazon ? detectAmazonPageType(url, null) : null;

    broadcastRuntimeMessage({
      type: 'TAB_STATUS_CHANGED',
      payload: {
        tabId,
        url,
        isAmazon,
        pageType,
      },
    });
  };

  const handleTabActivated = (activeInfo: { tabId: number }): void => {
    void (async () => {
      const url = await resolveTabUrl(activeInfo.tabId, '');
      if (!url) return;
      const isAmazon = isAmazonUrl(url);
      const pageType = isAmazon ? detectAmazonPageType(url, null) : null;

      broadcastRuntimeMessage({
        type: 'TAB_STATUS_CHANGED',
        payload: {
          tabId: activeInfo.tabId,
          url,
          isAmazon,
          pageType,
        },
      });
    })();
  };

  return {
    handleMessage,
    handleTabRemoved,
    handleTabUpdated,
    handleTabActivated,
  };
}

export const registerAmazonBackgroundHandlers = createAmazonBackgroundController;
