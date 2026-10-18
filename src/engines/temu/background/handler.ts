import { addTemuHistory } from '../db/history';
import {
  deleteTemuProductsBySession,
  getExistingTemuGoodsIds,
  upsertTemuProducts,
} from '../db/products';
import {
  clearActiveTemuSession,
  isTemuSessionStorageAvailable,
  readActiveTemuSession,
  writeActiveTemuSession,
  type ActiveTemuSessionPointer,
} from '../db/session-state';
import {
  ensureTemuSession,
  getActiveTemuSession,
  getTemuSession,
  reconcileInterruptedTemuSessions,
  updateTemuSessionStatus,
} from '../db/sessions';
import { getTemuSettings } from '../db/settings';
import { diagnoseTemuError } from '../diagnostics/error-diagnosis';
import { TemuProductSchema } from '../schemas/product';
import {
  isTemuMessage,
  validateTemuBackgroundIncomingMessage,
} from '../schemas/validate-message';
import { validateAndNormalizeTemuScrapedProduct } from '../scraper/field-parsers';
import {
  extractTemuSearchQuery,
} from '../scraper/page-detector';
import type { TemuProduct } from '../types/product';

const MAX_SEEDED_GOODS_IDS = 2000;

/**
 * Isolated background message router and lifecycle controller for the Temu engine.
 * Operates exclusively on `PPHuntTemuDB`, `pphunt.temu.activeSession`, and `TEMU_*` messages.
 */
export function registerTemuBackgroundHandlers(): {
  handleTemuMessage: (
    rawMessage: unknown,
    sender: unknown,
    sendResponse?: (response?: unknown) => void
  ) => boolean;
  onTemuTabUpdated: (tabId: number, changeInfo: { url?: string }) => void;
  onTemuTabRemoved: (tabId: number) => void;
  onTemuStartup: () => void;
} {
  let state: ActiveTemuSessionPointer = {
    tabId: null,
    sessionId: null,
    mode: 'automatic',
    targetCount: 50,
    startedAt: null,
    url: null,
    pageType: 'search',
    searchQuery: null,
    lastCollectedCount: 0,
  };
  let stateReady = false;
  let hydratePromise: Promise<void> | null = null;
  let pendingTemuProductsChain: Promise<void> = Promise.resolve();
  const finalizedTemuSessionIds = new Set<string>();
  let lastFinalizedTemuSessionId: string | null = null;

  async function doHydrate(): Promise<void> {
    const stored = await readActiveTemuSession();
    if (stored) {
      state = stored;
      stateReady = true;
      return;
    }
    try {
      if (isTemuSessionStorageAvailable()) {
        await reconcileInterruptedTemuSessions();
      }
      const row = await getActiveTemuSession();
      if (row) {
        state = {
          tabId: null,
          sessionId: row.sessionId,
          mode: row.mode,
          targetCount: row.targetCount,
          startedAt: row.startedAt,
          url: row.url || null,
          pageType: row.pageType,
          searchQuery: row.searchQuery,
          lastCollectedCount: row.collectedCount,
        };
      }
    } catch {
      // DB not ready at wake — proceed with empty pointer
    }
    stateReady = true;
  }

  function ensureHydrated(): Promise<void> {
    if (!hydratePromise) {
      hydratePromise = doHydrate().catch((err) => {
        console.warn('[PPHunt:Temu] Session hydration failed:', err);
        stateReady = true;
      });
    }
    return hydratePromise;
  }

  function persistState(): void {
    void writeActiveTemuSession(state).catch(() => {});
  }

  void ensureHydrated();

  function broadcastToUi(message: Record<string, unknown>): void {
    try {
      const maybePromise = browser.runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch {
      // UI sidepanel / overlay may not be open
    }
  }

  async function inspectTabContext(
    tabId: number
  ): Promise<{ url: string | null; status: string | null }> {
    try {
      const tabGetter = (
        browser.tabs as unknown as {
          get?: (id: number) => Promise<{ url?: string; status?: string }>;
        }
      )?.get;
      if (typeof tabGetter === 'function') {
        const tab = await tabGetter.call(browser.tabs, tabId);
        return {
          url: typeof tab?.url === 'string' ? tab.url : state.url,
          status: typeof tab?.status === 'string' ? tab.status : 'complete',
        };
      }
    } catch {
      // Tab may have been closed
    }
    return { url: state.url, status: null };
  }

  async function waitForTabReady(
    tabId: number,
    maxWaitMs = 4000
  ): Promise<void> {
    const tabGetter = (
      browser.tabs as unknown as {
        get?: (id: number) => Promise<{ status?: string }>;
      }
    )?.get;
    if (typeof tabGetter !== 'function') return;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        const tab = await tabGetter.call(browser.tabs, tabId);
        if (!tab || tab.status !== 'loading') return;
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function buildTemuScrollConfig(): Promise<{
    scroll: {
      scrollAmount: number;
      scrollInterval: number;
      waitAfterScroll: number;
    };
    duplicateDetection: boolean;
  }> {
    try {
      const s = await getTemuSettings();
      return {
        scroll: {
          scrollAmount: s.scrollAmount,
          scrollInterval: s.scrollInterval,
          waitAfterScroll: s.waitAfterScroll,
        },
        duplicateDetection: s.duplicateDetection,
      };
    } catch {
      return {
        scroll: {
          scrollAmount: 800,
          scrollInterval: 1500,
          waitAfterScroll: 2000,
        },
        duplicateDetection: true,
      };
    }
  }

  async function buildExistingGoodsIds(): Promise<string[]> {
    if (!state.sessionId) return [];
    try {
      const existing = await getExistingTemuGoodsIds(state.sessionId);
      return [...existing].slice(0, MAX_SEEDED_GOODS_IDS);
    } catch {
      return [];
    }
  }

  async function sendToTemuContentScriptWithRecovery(
    tabId: number,
    message: Record<string, unknown>
  ): Promise<unknown> {
    await waitForTabReady(tabId, 4000);
    try {
      return await browser.tabs.sendMessage(tabId, message);
    } catch (firstErr) {
      const firstErrMsg =
        firstErr instanceof Error ? firstErr.message : String(firstErr);

      if (
        /message channel closed before a response was received/i.test(
          firstErrMsg
        )
      ) {
        return null;
      }

      let finalErr: unknown = firstErr;
      try {
        if (browser.scripting?.executeScript) {
          let injected = false;
          try {
            await browser.scripting.executeScript({
              target: { tabId },
              files: ['/content-scripts/temu.js'],
            });
            injected = true;
          } catch (injectErr) {
            finalErr = injectErr;
          }

          if (injected) {
            try {
              return await browser.tabs.sendMessage(tabId, message);
            } catch (sendRetryErr) {
              const sendRetryMsg =
                sendRetryErr instanceof Error
                  ? sendRetryErr.message
                  : String(sendRetryErr);
              if (
                /message (?:channel|port) closed before a response was received/i.test(
                  sendRetryMsg
                )
              ) {
                return null;
              }
              await new Promise((r) => setTimeout(r, 80));
              try {
                return await browser.tabs.sendMessage(tabId, message);
              } catch {
                // Fall through to DOM bridge
              }
            }
          }

          await browser.scripting.executeScript({
            target: { tabId },
            func: (cmd: Record<string, unknown>) => {
              const w = window as unknown as {
                __PPHUNT_TEMU_DISPATCH_COMMAND__?: (c: unknown) => unknown;
              };
              if (typeof w.__PPHUNT_TEMU_DISPATCH_COMMAND__ === 'function') {
                return w.__PPHUNT_TEMU_DISPATCH_COMMAND__(cmd);
              }
              document.dispatchEvent(
                new CustomEvent('__PPHUNT_TEMU_COMMAND__', { detail: cmd })
              );
              return { ok: true };
            },
            args: [message],
          });
          return null;
        }
      } catch (retryErr) {
        finalErr = retryErr;
      }

      const tabCtx = await inspectTabContext(tabId);
      const { errorInfo } = diagnoseTemuError(
        finalErr instanceof Error ? finalErr : String(finalErr),
        {
          code: 'TEMU_SCRIPT_DISCONNECTED',
          url: tabCtx.url,
          tabStatus: tabCtx.status,
          preservedCount: state.lastCollectedCount,
          rawReason: `${firstErrMsg} | ${
            finalErr instanceof Error ? finalErr.message : String(finalErr)
          }`,
        }
      );

      if (state.sessionId) {
        await updateTemuSessionStatus(state.sessionId, 'error', {
          collected: state.lastCollectedCount,
        }).catch(() => {});
      }

      broadcastToUi({
        type: 'TEMU_COLLECTION_ERROR',
        payload: errorInfo,
      });
      return null;
    }
  }

  async function persistTemuCollectedProducts(
    rawProducts: unknown[],
    pageType: 'search' | 'product_detail' | 'category' | 'unknown',
    pageUrl: string
  ): Promise<void> {
    if (!state.sessionId && lastFinalizedTemuSessionId) {
      // Products arrived just as the session finalized; save under the finalized sessionId without reopening state
      const targetSessionId = lastFinalizedTemuSessionId;
      const nowIso = new Date().toISOString();
      const validated: TemuProduct[] = [];
      for (const raw of rawProducts) {
        if (!raw || typeof raw !== 'object') continue;
        const normalized = validateAndNormalizeTemuScrapedProduct(
          raw as Parameters<typeof validateAndNormalizeTemuScrapedProduct>[0],
          pageUrl
        );
        if (!normalized) continue;
        const parsed = TemuProductSchema.safeParse({
          ...normalized,
          collectedAt: nowIso,
          sessionId: targetSessionId,
        });
        if (parsed.success) validated.push(parsed.data);
      }
      if (validated.length > 0) {
        await upsertTemuProducts(validated, state.targetCount);
      }
      return;
    }

    if (!state.sessionId) {
      state.sessionId = crypto.randomUUID();
      state.startedAt = new Date().toISOString();
      await ensureTemuSession(
        state.sessionId,
        pageUrl || state.url || 'https://www.temu.com/',
        state.mode,
        state.targetCount,
        pageType,
        extractTemuSearchQuery(pageUrl),
        state.startedAt
      ).catch(() => {});
    }

    const sessionId = state.sessionId;
    if (finalizedTemuSessionIds.has(sessionId)) {
      return;
    }
    if (pageUrl) {
      state.url = pageUrl;
      state.pageType = pageType;
      const q = extractTemuSearchQuery(pageUrl);
      if (q) state.searchQuery = q;
    }
    persistState();

    const nowIso = new Date().toISOString();
    const validatedProducts: TemuProduct[] = [];
    let rejectedCount = 0;

    for (const raw of rawProducts) {
      if (!raw || typeof raw !== 'object') {
        rejectedCount++;
        continue;
      }
      const normalized = validateAndNormalizeTemuScrapedProduct(
        raw as Parameters<typeof validateAndNormalizeTemuScrapedProduct>[0],
        pageUrl
      );
      if (!normalized) {
        rejectedCount++;
        continue;
      }

      const candidate: TemuProduct = {
        ...normalized,
        collectedAt: nowIso,
        sessionId,
      };

      const parsed = TemuProductSchema.safeParse(candidate);
      if (parsed.success) {
        validatedProducts.push(parsed.data);
      } else {
        rejectedCount++;
      }
    }

    if (validatedProducts.length === 0) return;

    const { totalForSession } = await upsertTemuProducts(
      validatedProducts,
      state.targetCount
    );

    if (finalizedTemuSessionIds.has(sessionId)) {
      return;
    }

    state.lastCollectedCount = Math.max(
      state.lastCollectedCount,
      totalForSession
    );
    persistState();

    await updateTemuSessionStatus(
      sessionId,
      'collecting',
      {
        collected: state.lastCollectedCount,
        target: state.targetCount,
      },
      {
        url: state.url ?? pageUrl,
        pageType: state.pageType,
        searchQuery: state.searchQuery,
      }
    ).catch(() => {});

    broadcastToUi({
      type: 'TEMU_PRODUCTS_SCRAPED',
      payload: {
        products: validatedProducts,
        totalCollected: state.lastCollectedCount,
        targetCount: state.targetCount,
        sessionId,
        ...(rejectedCount > 0 ? { rejectedCount } : {}),
      },
    });
  }

  function handleTemuMessage(
    rawMessage: unknown,
    sender: unknown,
    sendResponse?: (response?: unknown) => void
  ): boolean {
    if (!isTemuMessage(rawMessage)) return false;

    const msg = validateTemuBackgroundIncomingMessage(rawMessage);
    if (!msg) {
      sendResponse?.({ ok: false, error: 'INVALID_TEMU_MESSAGE' });
      return false;
    }

    const senderTabUrl = (
      sender as { tab?: { url?: string } } | undefined
    )?.tab?.url;

    const route = (): void => {
      switch (msg.type) {
        case 'TEMU_START_COLLECTION': {
          const { mode, targetCount, tabId, sessionId } = msg.payload;
          state.tabId = tabId;
          state.sessionId = sessionId ?? crypto.randomUUID();
          finalizedTemuSessionIds.delete(state.sessionId);
          lastFinalizedTemuSessionId = null;
          state.mode = mode;
          state.targetCount = targetCount;
          state.startedAt = new Date().toISOString();
          state.lastCollectedCount = 0;
          persistState();

          void (async () => {
            const tabCtx = await inspectTabContext(tabId);
            if (tabCtx.url) {
              state.url = tabCtx.url;
              state.searchQuery = extractTemuSearchQuery(tabCtx.url);
              persistState();
            }
            if (state.sessionId) {
              await ensureTemuSession(
                state.sessionId,
                state.url ?? 'https://www.temu.com/',
                state.mode,
                state.targetCount,
                state.pageType,
                state.searchQuery,
                state.startedAt ?? undefined
              ).catch(() => {});
            }
            const { scroll, duplicateDetection } =
              await buildTemuScrollConfig();
            const existingGoodsIds = await buildExistingGoodsIds();
            if (existingGoodsIds && existingGoodsIds.length > 0) {
              state.lastCollectedCount = Math.max(
                state.lastCollectedCount,
                existingGoodsIds.length,
              );
              persistState();
            }
            await sendToTemuContentScriptWithRecovery(tabId, {
              type: 'TEMU_COLLECT_PRODUCTS',
              payload: {
                mode,
                targetCount,
                sessionId: state.sessionId,
                scroll,
                duplicateDetection,
                existingGoodsIds,
              },
            });
          })();
          break;
        }

        case 'TEMU_COLLECT_MANUAL': {
          const { tabId, sessionId, targetCount } = msg.payload;
          state.tabId = tabId;
          state.sessionId =
            sessionId ?? state.sessionId ?? crypto.randomUUID();
          state.mode = 'manual';
          if (typeof targetCount === 'number' && targetCount > 0) {
            state.targetCount = targetCount;
          }
          if (!state.startedAt) {
            state.startedAt = new Date().toISOString();
          }
          persistState();

          void (async () => {
            if (state.sessionId) {
              await ensureTemuSession(
                state.sessionId,
                state.url ?? 'https://www.temu.com/',
                'manual',
                state.targetCount,
                state.pageType,
                state.searchQuery,
                state.startedAt ?? undefined
              ).catch(() => {});
            }
            const { scroll, duplicateDetection } =
              await buildTemuScrollConfig();
            const existingGoodsIds = await buildExistingGoodsIds();
            await sendToTemuContentScriptWithRecovery(tabId, {
              type: 'TEMU_COLLECT_PRODUCTS',
              payload: {
                mode: 'manual',
                targetCount: state.targetCount,
                sessionId: state.sessionId,
                scroll,
                duplicateDetection,
                existingGoodsIds,
              },
            });
          })();
          break;
        }

        case 'TEMU_PAUSE_COLLECTION': {
          const { tabId } = msg.payload;
          if (state.sessionId) {
            void updateTemuSessionStatus(state.sessionId, 'paused', {
              collected: state.lastCollectedCount,
            }).catch(() => {});
          }
          browser.tabs
            .sendMessage(tabId, { type: 'TEMU_PAUSE_SCROLLING' })
            .catch(() => {});
          break;
        }

        case 'TEMU_RESUME_COLLECTION': {
          const { tabId } = msg.payload;
          if (state.sessionId) {
            void updateTemuSessionStatus(state.sessionId, 'collecting', {
              collected: state.lastCollectedCount,
            }).catch(() => {});
          }
          void sendToTemuContentScriptWithRecovery(tabId, {
            type: 'TEMU_RESUME_SCROLLING',
          });
          break;
        }

        case 'TEMU_STOP_COLLECTION': {
          const { tabId } = msg.payload;
          browser.tabs
            .sendMessage(tabId, { type: 'TEMU_STOP_COLLECTION_CMD' })
            .catch(() => {});

          void pendingTemuProductsChain.then(async () => {
            const stoppedSessionId = state.sessionId;
            const stoppedCount = state.lastCollectedCount;
            const stoppedTarget = state.targetCount;
            const stoppedUrl = state.url;
            const stoppedMode = state.mode;
            const stoppedStartedAt = state.startedAt;
            const stoppedPageType = state.pageType;
            const stoppedQuery = state.searchQuery;

            if (stoppedSessionId) {
              finalizedTemuSessionIds.add(stoppedSessionId);
              lastFinalizedTemuSessionId = stoppedSessionId;
            }
            state.tabId = null;
            state.sessionId = null;
            state.lastCollectedCount = 0;
            void clearActiveTemuSession();

            if (stoppedSessionId) {
              const completedAt = new Date().toISOString();
              await updateTemuSessionStatus(stoppedSessionId, 'stopped', {
                collected: stoppedCount,
                target: stoppedTarget,
              }).catch(() => {});
              if (stoppedCount > 0) {
                await addTemuHistory({
                  sessionId: stoppedSessionId,
                  url: stoppedUrl ?? 'https://www.temu.com/',
                  searchQuery: stoppedQuery,
                  pageType: stoppedPageType,
                  mode: stoppedMode,
                  targetCount: stoppedTarget,
                  collectedCount: stoppedCount,
                  startedAt: stoppedStartedAt ?? completedAt,
                  completedAt,
                  status: 'stopped',
                }).catch(() => {});
              }
            }
          });
          break;
        }

        case 'TEMU_GET_PAGE_STATUS': {
          const { tabId } = msg.payload;
          void (async () => {
            const resp = await sendToTemuContentScriptWithRecovery(tabId, {
              type: 'TEMU_GET_PAGE_STATUS',
              payload: { tabId },
            });
            if (resp && typeof resp === 'object' && 'type' in resp) {
              broadcastToUi(resp as Record<string, unknown>);
            }
          })();
          break;
        }

        case 'TEMU_CLEAR_SESSION_PRODUCTS': {
          const targetSessionId = msg.payload.sessionId ?? state.sessionId;
          if (targetSessionId) {
            void deleteTemuProductsBySession(targetSessionId).catch(() => {});
          }
          break;
        }

        case 'TEMU_PRODUCTS_COLLECTED': {
          const { products, pageType, pageUrl } = msg.payload;
          if (Array.isArray(products) && products.length > 0) {
            const targetUrl =
              pageUrl || senderTabUrl || 'https://www.temu.com/';
            const next = pendingTemuProductsChain.then(
              () => persistTemuCollectedProducts(products, pageType, targetUrl),
              () => persistTemuCollectedProducts(products, pageType, targetUrl),
            );
            pendingTemuProductsChain = next.catch((err) => {
              console.warn('[PPHunt:Temu] Failed to persist products:', err);
            });
          }
          break;
        }

        case 'TEMU_COLLECTION_PROGRESS': {
          const { collectedCount, targetCount, status } = msg.payload;
          if (
            state.sessionId &&
            finalizedTemuSessionIds.has(state.sessionId) &&
            status === 'collecting'
          ) {
            break;
          }
          state.lastCollectedCount = Math.max(
            state.lastCollectedCount,
            collectedCount
          );
          persistState();

          if (state.sessionId) {
            void updateTemuSessionStatus(state.sessionId, status, {
              collected: state.lastCollectedCount,
              target: targetCount,
            }).catch(() => {});
          }

          broadcastToUi({
            type: 'TEMU_COLLECTION_PROGRESS',
            payload: {
              ...msg.payload,
              collectedCount: state.lastCollectedCount,
            },
          });
          break;
        }

        case 'TEMU_COLLECTION_COMPLETE': {
          const { totalCollected, reason } = msg.payload;
          void pendingTemuProductsChain.then(async () => {
            const finalCount = Math.max(
              state.lastCollectedCount,
              totalCollected,
            );
            const completedSessionId =
              state.sessionId ?? lastFinalizedTemuSessionId;
            const completedTarget = state.targetCount;
            const completedUrl =
              state.url ?? senderTabUrl ?? 'https://www.temu.com/';
            const completedMode = state.mode;
            const completedPageType = state.pageType;
            const completedQuery = state.searchQuery;
            const completedStartedAt = state.startedAt;
            const finalStatus =
              reason === 'user_stopped'
                ? 'stopped'
                : reason === 'error'
                  ? 'error'
                  : 'completed';

            if (completedSessionId) {
              finalizedTemuSessionIds.add(completedSessionId);
              lastFinalizedTemuSessionId = completedSessionId;
            }
            state.tabId = null;
            state.sessionId = null;
            state.lastCollectedCount = 0;
            void clearActiveTemuSession();

            if (completedSessionId) {
              const completedAt = new Date().toISOString();
              const existingRow = await getTemuSession(completedSessionId);
              await updateTemuSessionStatus(completedSessionId, finalStatus, {
                collected: finalCount,
                target: completedTarget,
              }).catch(() => {});

              if (finalCount > 0) {
                await addTemuHistory({
                  sessionId: completedSessionId,
                  url: existingRow?.url || completedUrl,
                  searchQuery: existingRow?.searchQuery ?? completedQuery,
                  pageType: existingRow?.pageType ?? completedPageType,
                  mode: existingRow?.mode ?? completedMode,
                  targetCount: existingRow?.targetCount ?? completedTarget,
                  collectedCount: finalCount,
                  startedAt:
                    existingRow?.startedAt ??
                    completedStartedAt ??
                    completedAt,
                  completedAt,
                  status: finalStatus,
                }).catch(() => {});
              }
            }

            broadcastToUi({
              type: 'TEMU_COLLECTION_STATUS',
              payload: {
                status: finalStatus,
                collectedCount: finalCount,
                targetCount: completedTarget,
                sessionId: completedSessionId,
                reason,
              },
            });
          });
          break;
        }

        case 'TEMU_COLLECTION_ERROR': {
          const { errorInfo } = diagnoseTemuError(msg.payload, {
            code: msg.payload.code,
            category: msg.payload.category,
            title: msg.payload.title,
            remedy: msg.payload.remedy,
            url: senderTabUrl ?? state.url,
            pageType: state.pageType,
            preservedCount: state.lastCollectedCount,
          });

          if (state.sessionId) {
            void updateTemuSessionStatus(state.sessionId, 'error', {
              collected: state.lastCollectedCount,
            }).catch(() => {});
          }

          broadcastToUi({
            type: 'TEMU_COLLECTION_ERROR',
            payload: errorInfo,
          });
          break;
        }
      }
    };

    try {
      if (!stateReady) {
        void ensureHydrated().then(() => {
          try {
            route();
          } catch (deferredErr) {
            console.error(
              '[PPHunt:Temu] Deferred message handler failed:',
              deferredErr
            );
          }
        });
        sendResponse?.({ ok: true });
        return false;
      }
      route();
      sendResponse?.({ ok: true });
      return false;
    } catch (err) {
      console.error('[PPHunt:Temu] Message handler failed:', err);
      sendResponse?.({ ok: false, error: 'TEMU_HANDLER_ERROR' });
      return false;
    }
  }

  function onTemuTabUpdated(
    tabId: number,
    changeInfo: { url?: string }
  ): void {
    if (!changeInfo.url) return;
    void ensureHydrated().then(() => {
      if (tabId === state.tabId) {
        state.url = changeInfo.url ?? null;
        persistState();
      }
    });
  }

  function onTemuTabRemoved(tabId: number): void {
    void ensureHydrated().then(() => {
      if (tabId === state.tabId) {
        const savedCount = state.lastCollectedCount;
        const closedSessionId = state.sessionId;
        const closedUrl = state.url;

        state.tabId = null;
        state.sessionId = null;
        state.lastCollectedCount = 0;
        void clearActiveTemuSession();

        if (closedSessionId) {
          void updateTemuSessionStatus(closedSessionId, 'stopped', {
            collected: savedCount,
          }).catch(() => {});
        }

        const errorMsg =
          savedCount > 0
            ? `The Temu collection tab was closed — ${savedCount} products were saved.`
            : 'The Temu collection tab was closed.';

        const { errorInfo } = diagnoseTemuError(errorMsg, {
          code: 'TEMU_TAB_CLOSED',
          url: closedUrl,
          tabStatus: 'closed',
          preservedCount: savedCount,
        });

        broadcastToUi({
          type: 'TEMU_COLLECTION_ERROR',
          payload: errorInfo,
        });
      }
    });
  }

  function onTemuStartup(): void {
    void reconcileInterruptedTemuSessions().catch(() => {});
  }

  return {
    handleTemuMessage,
    onTemuTabUpdated,
    onTemuTabRemoved,
    onTemuStartup,
  };
}
