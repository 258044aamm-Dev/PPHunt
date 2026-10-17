import { db } from '@/lib/db/database';
import { addHistory } from '@/lib/db/history';
import { updateSessionStatus } from '@/lib/db/sessions';
import { getSettings } from '@/lib/db/settings';
import { getExistingASINs } from '@/lib/db/products';
import { MAX_SEEDED_ASINS } from '@/constants/defaults';
import { ensureSession, getActiveSession, reconcileInterruptedSessions } from '@/lib/db/sessions';
import {
  readActiveSession,
  writeActiveSession,
  isSessionStorageAvailable,
  type ActiveSessionPointer,
} from '@/lib/db/session-state';
import { diagnoseError } from '@/lib/diagnostics/error-diagnosis';
import { ProductSchema } from '@/lib/schemas/product';
import { validateExtensionMessage } from '@/lib/schemas';
import { validateAndNormalizeScrapedProduct } from '@/lib/scraper/field-parsers';
import { OPENING_MODE_KEY, readOpeningMode, type OpeningMode } from '@/lib/ui/openingMode';
import { isOverlayAllowed, openOverlayForTab } from '@/lib/overlay/openOverlay';
import { registerTemuBackgroundHandlers } from '@/engines/temu/background/handler';
import { isTemuMessage } from '@/engines/temu/schemas/validate-message';
import type { Product } from '@/types/product';

export default defineBackground(() => {
  console.log('[PPHunt] Background service worker started');

  const temuHandlers = registerTemuBackgroundHandlers();

  // L-5 (SAD-197): browser startup is the one moment where nothing can
  // legitimately be collecting — belt-and-braces alongside the doHydrate
  // reconciliation, in case the panel never wakes the worker that session.
  // Optional call: test stubs of `browser` may not implement onStartup.
  browser.runtime.onStartup?.addListener(() => {
    void reconcileInterruptedSessions().catch(() => {});
    temuHandlers.onTemuStartup();
  });

  // ─── Active-session state (H-8, SAD-173) ───
  // Survives MV3 worker termination: every mutation is mirrored to
  // chrome.storage.session and the router rehydrates the pointer before
  // touching it. IndexedDB (getActiveSession) is the fallback when the
  // pointer is absent (e.g. after a full browser restart). The wire
  // contract is untouched: acks and `return false` stay synchronous.
  let state: ActiveSessionPointer = {
    tabId: null,
    sessionKey: null,
    mode: 'manual',
    targetCount: 50,
    startedAt: null,
    url: null,
    lastCollectedCount: 0,
  };
  let stateReady = false;
  let hydratePromise: Promise<void> | null = null;

  async function doHydrate(): Promise<void> {
    const stored = await readActiveSession();
    if (stored) {
      state = stored;
      stateReady = true;
      return;
    }
    try {
      // L-5 (SAD-197): storage.session AVAILABLE but pointer absent is the
      // signature of a browser restart (Chrome wipes storage.session on
      // close; a live run always mirrors its pointer, H-8/Step 4.2). Nothing
      // can legitimately be collecting then, so reconcile dead 'collecting'
      // rows to 'interrupted' BEFORE the fallback below can resurrect one.
      // When storage.session is MISSING (Firefox / older Chrome) the IDB
      // fallback is the deliberate mid-session survival path — reconciling
      // there would kill live sessions on every worker bounce.
      if (isSessionStorageAvailable()) {
        await reconcileInterruptedSessions();
      }
      const row = await getActiveSession();
      if (row) {
        state = {
          tabId: row.tabId,
          sessionKey: row.id,
          mode: row.mode,
          targetCount: row.targetCount,
          startedAt: row.startedAt,
          url: row.url || null,
          lastCollectedCount: row.collectedCount,
        };
      }
    } catch {
      // DB not ready at wake — proceed with the empty pointer.
    }
    stateReady = true;
  }

  function ensureHydrated(): Promise<void> {
    if (!hydratePromise) {
      hydratePromise = doHydrate().catch((err) => {
        console.warn('[BG] Session hydration failed:', err);
        stateReady = true;
      });
    }
    return hydratePromise;
  }

  function persistState(): void {
    void writeActiveSession(state).catch(() => {});
  }
  let openingMode: OpeningMode | null = null;
  let preferenceRevision = 0;

  // One toolbar owner at a time: a saved preference uses action.onClicked;
  // without a preference the action popup is the chooser. Chrome's automatic
  // side-panel-on-click behavior would bypass both of those routes.
  const configureAction = async () => {
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    const revision = preferenceRevision;
    const saved = await browser.storage.local.get(OPENING_MODE_KEY);
    // A storage event may supersede this asynchronous read.
    if (revision !== preferenceRevision) return;
    openingMode = readOpeningMode(saved[OPENING_MODE_KEY]);
    await browser.action.setPopup({ popup: openingMode ? '' : 'popup.html' });
  };
  void configureAction().catch((error) => console.error('[PPHunt] Toolbar setup failed:', error));
  // H-8 (SAD-173): start rehydrating the session pointer immediately so the
  // first router message usually finds it already loaded.
  void ensureHydrated();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[OPENING_MODE_KEY]) return;
    preferenceRevision++;
    openingMode = readOpeningMode(changes[OPENING_MODE_KEY].newValue);
    void browser.action.setPopup({ popup: openingMode ? '' : 'popup.html' });
    void browser.action.setBadgeText({ text: '' });
    void browser.action.setTitle({ title: 'PPHunt' });
  });

  const showActionError = (message: string) => {
    console.warn('[PPHunt]', message);
    void browser.action.setBadgeText({ text: '!' });
    void browser.action.setBadgeBackgroundColor({ color: '#d97757' });
    void browser.action.setTitle({ title: `PPHunt — ${message}` });
  };
  const clearActionError = () => {
    void browser.action.setBadgeText({ text: '' });
    void browser.action.setTitle({ title: 'PPHunt' });
  };

  // Called only when the popup is disabled by a saved mode.
  browser.action.onClicked.addListener((tab) => {
    if (!tab?.id) return;
    if (openingMode === 'sidePanel') {
      void browser.sidePanel.open({ tabId: tab.id }).then(clearActionError)
        .catch((error) => showActionError(`Could not open sidebar: ${String(error)}`));
    } else if (openingMode === 'overlay') {
      if (!isOverlayAllowed(tab.url)) {
        showActionError('Overlay unavailable here; opening sidebar instead');
        void browser.sidePanel.open({ tabId: tab.id }).catch(console.warn);
        return;
      }
      void openOverlayForTab(tab.id, tab.url).then(clearActionError)
        .catch((error) => showActionError(`Could not open overlay: ${String(error)}`));
    } else {
      // An outdated popup configuration can occur briefly after service-worker wake.
      void configureAction().catch((error) => showActionError(`Toolbar setup failed: ${String(error)}`));
    }
  });

  /**
   * Probes the target browser tab for URL and loading status without throwing
   * if `browser.tabs.get` is unavailable or the tab was closed.
   */
  async function inspectTabContext(
    tabId: number
  ): Promise<{ url: string | null; status: string | null }> {
    try {
      const tabGetter = (browser.tabs as any)?.get;
      if (typeof tabGetter === 'function') {
        const tab = await tabGetter.call(browser.tabs, tabId);
        return {
          url: typeof tab?.url === 'string' ? tab.url : state.url,
          status: typeof tab?.status === 'string' ? tab.status : 'complete',
        };
      }
    } catch {
      // Tab may have been closed or tabs.get is not mocked in unit test
    }
    return { url: state.url, status: null };
  }

  /**
   * Waits until `tabId` finishes loading (`status === 'complete'`) if `browser.tabs.get`
   * is available and reports `'loading'`, up to `maxWaitMs`.
   */
  async function waitForTabReady(
    tabId: number,
    maxWaitMs = 5000
  ): Promise<void> {
    const tabGetter = (browser.tabs as any)?.get;
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

  /**
   * Sends a command to the content script on `tabId`.
   * If the content script is not yet injected or disconnected, attempts to re-inject
   * `content-scripts/amazon.js` once and retry (with direct-dispatch fallback) before
   * reporting a diagnosed error.
   */
  /**
   * H-1b (SAD-170): read the persisted scroll settings and shape them into
   * the COLLECT_PRODUCTS `scroll` payload. Falls back to the pre-wiring
   * hardcoded values if the settings row cannot be read, so a DB hiccup can
   * never block collection.
   */
  async function buildScrollConfig(): Promise<{
    scrollAmount: number;
    scrollInterval: number;
    waitAfterScroll: number;
    duplicateDetection: boolean;
  }> {
    try {
      const s = await getSettings();
      return {
        scrollAmount: s.scrollSpeed,
        scrollInterval: s.scrollInterval,
        waitAfterScroll: s.waitAfterScroll,
        duplicateDetection: s.duplicateDetection,
      };
    } catch (err) {
      console.warn('[BG] Failed to read scroll settings, using defaults:', err);
      return {
        scrollAmount: 800,
        scrollInterval: 500,
        waitAfterScroll: 1500,
        duplicateDetection: true,
      };
    }
  }

  /**
   * M-1 (SAD-175): ASINs already stored for the active session, bounded so
   * the message stays small. Above the cap dedup seeding is best-effort —
   * persistCollectedProducts dedups on write regardless, so the DB stays
   * correct; only the pre-seeded count in the UI is approximate.
   */
  async function buildExistingAsins(): Promise<string[]> {
    if (!state.sessionKey) return [];
    try {
      const existing = await getExistingASINs(state.sessionKey);
      return [...existing].slice(0, MAX_SEEDED_ASINS);
    } catch {
      return [];
    }
  }

  async function sendToContentScriptWithRecovery(
    tabId: number,
    message: Record<string, unknown>
  ): Promise<void> {
    await waitForTabReady(tabId, 4000);
    try {
      await browser.tabs.sendMessage(tabId, message);
      return;
    } catch (firstErr) {
      const firstErrMsg =
        firstErr instanceof Error ? firstErr.message : String(firstErr);

      // If the content script received the message and returned true without sendResponse,
      // the command is already running on the page — do not re-inject a duplicate instance.
      if (
        /message channel closed before a response was received/i.test(
          firstErrMsg
        )
      ) {
        console.info(
          `[BG] Content script on tab ${tabId} accepted ${String(message.type)} (async channel closed after dispatch).`
        );
        return;
      }

      console.warn(
        `[BG] Initial sendMessage(${String(message.type)}) to tab ${tabId} failed, attempting recovery:`,
        firstErr
      );
      let finalErr: unknown = firstErr;
      try {
        if (browser.scripting?.executeScript) {
          // H-2 (SAD-165): canonical WXT path carries the leading slash
          // (.wxt/types/paths.d.ts), and the DOM-bridge fallback below is no
          // longer nested inside the injection's try — an executeScript
          // rejection (restricted page, INJECTION_BLOCKED, tab closed) must
          // not skip it.
          let injected = false;
          try {
            await browser.scripting.executeScript({
              target: { tabId },
              files: ['/content-scripts/amazon.js'],
            });
            injected = true;
          } catch (injectErr) {
            finalErr = injectErr;
            console.warn(
              '[BG] Content script re-injection failed, falling back to DOM bridge:',
              injectErr
            );
          }

          if (injected) {
            try {
              await browser.tabs.sendMessage(tabId, message);
              return;
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
                return;
              }
              // Brief settle delay after script injection, then retry once
              // before falling through to the DOM bridge
              await new Promise((r) => setTimeout(r, 80));
              try {
                await browser.tabs.sendMessage(tabId, message);
                return;
              } catch {
                // fall through to the DOM bridge below
              }
            }
          }

          // Last resort: dispatch the command via the content-script DOM bridge
          await browser.scripting.executeScript({
            target: { tabId },
            func: (cmd: Record<string, unknown>) => {
              const w = window as unknown as {
                __PPHUNT_DISPATCH_COMMAND__?: (c: unknown) => unknown;
              };
              if (typeof w.__PPHUNT_DISPATCH_COMMAND__ === 'function') {
                return w.__PPHUNT_DISPATCH_COMMAND__(cmd);
              }
              document.dispatchEvent(
                new CustomEvent('__PPHUNT_COMMAND__', { detail: cmd })
              );
              return { ok: true };
            },
            args: [message],
          });
          return;
        }
      } catch (retryErr) {
        finalErr = retryErr;
        console.warn('[BG] Content script recovery failed:', retryErr);
      }

      const tabCtx = await inspectTabContext(tabId);
      const diagnostic = diagnoseError(
        finalErr instanceof Error ? finalErr : String(finalErr),
        {
          code: 'SCRIPT_DISCONNECTED',
          url: tabCtx.url,
          tabStatus: tabCtx.status,
          preservedCount: state.lastCollectedCount,
          rawReason: `${firstErrMsg} | ${finalErr instanceof Error ? finalErr.message : String(finalErr)}`,
        }
      );

      if (state.sessionKey) {
        await updateSessionStatus(
          state.sessionKey,
          'error',
          { collected: state.lastCollectedCount },
          diagnostic.summary
        ).catch(() => {});
      }
      browser.runtime
        .sendMessage({
          type: 'UPDATE_PROGRESS',
          payload: {
            collected: state.lastCollectedCount,
            target: 0,
            status: 'error',
            error: diagnostic.summary,
            sessionKey: state.sessionKey,
            diagnostic,
          },
        })
        .catch(() => {});
    }
  }

  /**
   * Validates, deduplicates per sessionKey, and persists collected products with per-item fallback
   * so a single bad record never corrupts or drops the rest of the batch.
   */
  async function persistCollectedProducts(
    rawProducts: any[],
    totalCount: number,
    senderUrl?: string
  ): Promise<void> {
    if (!state.sessionKey) {
      // Step 4.1 (SAD-172): canonical `${tabId}_${ts}` format (same as
      // createSession) and a real row, so status updates and the History
      // read-back never operate on a key with no row.
      const mintTabId = state.tabId ?? 0;
      state.sessionKey = `${mintTabId}_${Date.now()}`;
      await ensureSession(
        state.sessionKey,
        mintTabId,
        senderUrl ?? state.url ?? 'https://www.amazon.com/'
      ).catch(() => {});
    }
    const sessionKey = state.sessionKey;
    if (senderUrl) {
      state.url = senderUrl;
    }
    persistState();
    const nowIso = new Date().toISOString();

    const validatedProducts: Product[] = [];
    // M-7 (SAD-180): schema rejections were silently dropped — no log, no
    // counter, no notification. Collect them (ASIN + issue paths) so the
    // operator can see systematic validation failures.
    const rejections: Array<{ asin: string; issues: string }> = [];
    for (const raw of rawProducts) {
      const normalized = validateAndNormalizeScrapedProduct(raw, senderUrl);
      if (!normalized) continue;

      const candidate = {
        ...normalized,
        collectedAt:
          typeof raw?.collectedAt === 'string' ? raw.collectedAt : nowIso,
        sessionKey:
          typeof raw?.sessionKey === 'string' && raw.sessionKey.length > 0
            ? raw.sessionKey
            : sessionKey,
      };

      const parsed = ProductSchema.safeParse(candidate);
      if (parsed.success) {
        validatedProducts.push(parsed.data);
      } else {
        rejections.push({
          asin: typeof normalized.asin === 'string' ? normalized.asin : 'unknown',
          issues: parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        });
      }
    }

    if (rejections.length > 0) {
      console.warn(
        `[BG] ProductSchema rejected ${rejections.length}/${
          validatedProducts.length + rejections.length
        } products in batch (first 5):`,
        rejections.slice(0, 5)
      );
    }

    if (validatedProducts.length === 0) return;

    // Deduplicate and enrich against existing products in IndexedDB for this sessionKey
    const existingSessionProducts = await db.products
      .where('sessionKey')
      .equals(sessionKey)
      .toArray();
    const existingByAsin = new Map<string, Product>();
    for (const p of existingSessionProducts) {
      existingByAsin.set(p.asin.toUpperCase(), p);
    }

    const toInsert: Product[] = [];
    const toUpdate: Product[] = [];

    for (const item of validatedProducts) {
      const key = item.asin.toUpperCase();
      const prev = existingByAsin.get(key);
      if (!prev) {
        existingByAsin.set(key, item);
        toInsert.push(item);
      } else if (prev.id != null) {
        let changed = false;
        const merged: Product = { ...prev };
        const nullableFields: (keyof Product)[] = [
          'title',
          'price',
          'listPrice',
          'discountPercentage',
          'dealBadge',
          'currency',
          'rating',
          'reviewCount',
          'bestSellersRank',
          'pastMonthSales',
          'coupon',
          'badge',
          'delivery',
          'imageUrl',
          'brand',
          'availability',
          'seller',
          'description',
        ];
        for (const field of nullableFields) {
          if (merged[field] == null && item[field] != null) {
            (merged as any)[field] = item[field];
            changed = true;
          }
        }
        if (!merged.isPrime && item.isPrime) {
          merged.isPrime = true;
          changed = true;
        }
        if (!merged.isSponsored && item.isSponsored) {
          merged.isSponsored = true;
          changed = true;
        }
        if (
          (!merged.features || merged.features.length === 0) &&
          item.features &&
          item.features.length > 0
        ) {
          merged.features = item.features;
          changed = true;
        }
        if (changed) {
          existingByAsin.set(key, merged);
          toUpdate.push(merged);
        }
      }
    }

    // Batch write with per-record fallback so one failed record never drops valid siblings
    if (toInsert.length > 0) {
      try {
        await db.products.bulkAdd(toInsert);
      } catch (bulkErr) {
        console.warn('[BG] bulkAdd failed, falling back to per-item add:', bulkErr);
        for (const item of toInsert) {
          await db.products.add(item).catch((e) =>
            console.warn('[BG] Isolated item add error:', e)
          );
        }
      }
    }

    if (toUpdate.length > 0) {
      try {
        await db.products.bulkPut(toUpdate);
      } catch (bulkErr) {
        console.warn('[BG] bulkPut failed, falling back to per-item put:', bulkErr);
        for (const item of toUpdate) {
          await db.products.put(item).catch((e) =>
            console.warn('[BG] Isolated item put error:', e)
          );
        }
      }
    }

    state.lastCollectedCount = Math.max(
      state.lastCollectedCount,
      totalCount,
      existingByAsin.size
    );

    await updateSessionStatus(sessionKey, 'collecting', {
      collected: state.lastCollectedCount,
    }).catch(() => {});

    browser.runtime
      .sendMessage({
        type: 'UPDATE_PROGRESS',
        payload: {
          collected: state.lastCollectedCount,
          target: 0, // Will be set by side panel
          status: 'collecting',
          error: null,
          sessionKey,
          // M-7 (SAD-180): let the side panel surface a non-fatal attention
          // toast when the rejection ratio crosses its threshold (the panel
          // owns the notifications gate, so a user who disabled notifications
          // never sees it).
          ...(rejections.length > 0
            ? {
                rejected: rejections.length,
                rejectedOf: validatedProducts.length + rejections.length,
              }
            : {}),
        },
      })
      .catch(() => {
        // Side panel might not be open, that's OK
      });
  }

  // ─── Message Router ───
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender,
      sendResponse?: (response?: unknown) => void
    ) => {
      if (isTemuMessage(message)) {
        return temuHandlers.handleTemuMessage(message, sender, sendResponse);
      }

      // H-3 (SAD-164): validate every message at the router boundary.
      // Unknown types are ignored silently (unchanged behaviour); known types
      // with malformed payloads are discarded with an explicit
      // INVALID_MESSAGE response — never throw, never leave the sender's
      // channel hanging.
      const validation = validateExtensionMessage(message);
      if (validation.status === 'unknown') return false;
      if (validation.status === 'invalid') {
        console.warn(
          `[BG] Discarding malformed ${validation.type} message: ${validation.issues}`
        );
        sendResponse?.({ ok: false, error: 'INVALID_MESSAGE' });
        return false;
      }
      const msg = validation.message;

      // H-8 (SAD-173): branch bodies run against hydrated state. When the
      // worker just woke, the ack below is still delivered synchronously and
      // only the branch side effects are deferred until hydration resolves.
      const route = (): boolean => {
      switch (msg.type) {
      // Side Panel → Background: Start collection
      case 'START_COLLECTION': {
        const { mode, targetCount, tabId, sessionKey } = msg.payload;
        state.tabId = tabId;
        // Step 4.1 (SAD-172): canonical `${tabId}_${ts}` format when minting.
        state.sessionKey =
          typeof sessionKey === 'string' && sessionKey.length > 0
            ? sessionKey
            : `${tabId}_${Date.now()}`;
        state.mode = mode === 'automatic' ? 'automatic' : 'manual';
        state.targetCount =
          typeof targetCount === 'number' && targetCount > 0 ? targetCount : 50;
        state.startedAt = new Date().toISOString();
        state.lastCollectedCount = 0;
        persistState();
        console.log(
          `[BG] START_COLLECTION → tab ${tabId}, mode: ${mode}, target: ${targetCount}`
        );

        void (async () => {
          // H-5a/H-8: guarantee a row for the exact key in use — panel keys
          // normally already have one (createSession, never clobbered), while
          // background mints or keys whose row was lost get one now, stamped
          // with the pointer's authoritative startedAt. Without this the
          // first status update would upsert a row stamped with the UPDATE
          // time and History would lose the real start.
          if (state.sessionKey) {
            await ensureSession(
              state.sessionKey,
              tabId,
              state.url ?? '',
              state.mode,
              state.targetCount,
              state.startedAt ?? undefined
            ).catch(() => {});
          }
          const scroll = await buildScrollConfig();
          const existingAsins = await buildExistingAsins();
          await sendToContentScriptWithRecovery(tabId, {
            type: 'COLLECT_PRODUCTS',
            payload: { mode, targetCount, scroll, existingAsins },
          });
        })();
        break;
      }

      // Side Panel → Background: Reload tab and retry collection
      case 'RELOAD_AND_RETRY_COLLECTION': {
        const { mode, targetCount, tabId, sessionKey } = msg.payload;
        state.tabId = tabId;
        if (typeof sessionKey === 'string' && sessionKey.length > 0) {
          state.sessionKey = sessionKey;
        } else if (!state.sessionKey) {
          // Step 4.1 (SAD-172): canonical format + row creation below.
          state.sessionKey = `${tabId}_${Date.now()}`;
        }
        state.mode = mode === 'automatic' ? 'automatic' : 'manual';
        state.targetCount =
          typeof targetCount === 'number' && targetCount > 0 ? targetCount : 50;
        persistState();

        void (async () => {
          try {
            if (state.sessionKey) {
              await ensureSession(
                state.sessionKey,
                tabId,
                state.url ?? '',
                mode === 'automatic' ? 'automatic' : 'manual',
                typeof targetCount === 'number' && targetCount > 0
                  ? targetCount
                  : 50,
                state.startedAt ?? undefined
              ).catch(() => {});
            }
            const reloadFn = (browser.tabs as any)?.reload;
            if (typeof reloadFn === 'function') {
              await reloadFn.call(browser.tabs, tabId);
              await new Promise((r) => setTimeout(r, 900));
              await waitForTabReady(tabId, 6000);
            }
          } catch (err) {
            console.warn('[BG] Tab reload before retry failed:', err);
          }
          const scroll = await buildScrollConfig();
          const existingAsins = await buildExistingAsins();
          await sendToContentScriptWithRecovery(tabId, {
            type: 'COLLECT_PRODUCTS',
            payload: { mode, targetCount, scroll, existingAsins },
          });
        })();
        break;
      }

      // Side Panel → Background: Pause
      case 'PAUSE_COLLECTION': {
        const { tabId } = msg.payload;
        browser.tabs
          .sendMessage(tabId, { type: 'PAUSE_SCROLLING' })
          .catch(console.warn);
        break;
      }

      // Side Panel → Background: Resume
      case 'RESUME_COLLECTION': {
        const { tabId } = msg.payload;
        void sendToContentScriptWithRecovery(tabId, {
          type: 'RESUME_SCROLLING',
        });
        break;
      }

      // Side Panel → Background: Stop
      case 'STOP_COLLECTION': {
        const { tabId } = msg.payload;
        state.tabId = null;
        state.sessionKey = null;
        state.lastCollectedCount = 0;
        persistState();
        browser.tabs
          .sendMessage(tabId, { type: 'STOP_COLLECTION_CMD' })
          .catch(console.warn);
        break;
      }

      // Content Script → Background: New products found
      case 'PRODUCTS_COLLECTED': {
        const { products, totalCount } = msg.payload;
        console.log(
          `[BG] PRODUCTS_COLLECTED: ${products.length} products, total: ${totalCount}`
        );

        if (Array.isArray(products) && products.length > 0) {
          void persistCollectedProducts(
            products,
            totalCount,
            sender?.tab?.url
          ).catch((err) =>
            console.warn('[BG] Failed to store products:', err)
          );
        }
        break;
      }

      // Content Script → Background: Progress update
      case 'COLLECTION_PROGRESS': {
        const { collected, target, status } = msg.payload;
        if (typeof collected === 'number' && collected >= 0) {
          state.lastCollectedCount = Math.max(state.lastCollectedCount, collected);
          persistState();
        }
        console.log(
          `[BG] COLLECTION_PROGRESS: ${collected}/${target} — ${status}`
        );

        const sessionKeyForProgress = state.sessionKey;
        if (sessionKeyForProgress) {
          void updateSessionStatus(sessionKeyForProgress, status, {
            collected: state.lastCollectedCount,
            target,
          }).catch(() => {});

          if (status === 'completed') {
            const completedAt = new Date().toISOString();
            void (async () => {
              try {
                const session = await db.sessions.get(sessionKeyForProgress);
                await addHistory({
                  sessionKey: sessionKeyForProgress,
                  url:
                    session?.url ??
                    state.url ??
                    sender?.tab?.url ??
                    'https://www.amazon.com/',
                  mode: session?.mode ?? state.mode,
                  targetCount:
                    session?.targetCount ??
                    (typeof target === 'number' && target > 0
                      ? target
                      : state.targetCount),
                  collectedCount: state.lastCollectedCount,
                  startedAt:
                    session?.startedAt ?? state.startedAt ?? completedAt,
                  completedAt,
                  status: 'completed',
                });
              } catch (err) {
                console.warn('[BG] Failed to write history on completion:', err);
              }
            })();
          }
        }

        // Forward to side panel
        browser.runtime
          .sendMessage({
            type: 'UPDATE_PROGRESS',
            payload: {
              collected: state.lastCollectedCount,
              target,
              status,
              error: null,
              sessionKey: sessionKeyForProgress,
            },
          })
          .catch(() => {});
        break;
      }

      // Content Script → Background: Error detected
      case 'CONTENT_ERROR': {
        const { code, message } = msg.payload;
        console.warn(`[BG] CONTENT_ERROR [${code}]:`, message);

        const diagnostic = diagnoseError(message, {
          code,
          url: sender?.tab?.url ?? state.url,
          tabStatus: (sender?.tab as any)?.status ?? 'complete',
          preservedCount: state.lastCollectedCount,
        });

        if (state.sessionKey) {
          void updateSessionStatus(
            state.sessionKey,
            'error',
            { collected: state.lastCollectedCount },
            message
          ).catch(() => {});
        }

        // Forward to side panel while preserving state.lastCollectedCount
        browser.runtime
          .sendMessage({
            type: 'UPDATE_PROGRESS',
            payload: {
              collected: state.lastCollectedCount,
              target: 0,
              status: 'error',
              error: message,
              sessionKey: state.sessionKey,
              diagnostic,
            },
          })
          .catch(() => {});
        break;
      }

      default:
        return false;
    }

      return true;
      };

      try {
        if (!stateReady) {
          void ensureHydrated().then(() => {
            try {
              route();
            } catch (deferredErr) {
              console.error('[BG] Message handler failed (deferred):', deferredErr);
            }
          });
          sendResponse?.({ ok: true });
          return false;
        }
        if (!route()) return false;
        sendResponse?.({ ok: true });
        return false;
      } catch (err) {
        // spec/11-messaging-protocol.md:170 — the router must never crash the
        // listener; answer so the sender never sees a closed channel.
        console.error('[BG] Message handler failed:', err);
        sendResponse?.({ ok: false, error: 'HANDLER_ERROR' });
        return false;
      }
  });

  // ─── Tab Tracking ───
  browser.tabs.onActivated.addListener((activeInfo) => {
    console.log('[BG] Tab activated:', activeInfo.tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    temuHandlers.onTemuTabUpdated(tabId, changeInfo);
    if (changeInfo.url) {
      console.log('[BG] Tab URL changed:', tabId, changeInfo.url);
      void ensureHydrated().then(() => {
        if (tabId === state.tabId) {
          state.url = changeInfo.url ?? null;
          persistState();
        }
      });
    }
  });

  // Detect when the collection tab is closed
  browser.tabs.onRemoved.addListener((tabId) => {
    temuHandlers.onTemuTabRemoved(tabId);
    void ensureHydrated().then(() => {
    if (tabId === state.tabId) {
      console.log('[BG] Collection tab closed:', tabId);
      const savedCount = state.lastCollectedCount;
      const closedSessionKey = state.sessionKey;
      const closedUrl = state.url;
      state.tabId = null;
      state.sessionKey = null;
      state.lastCollectedCount = 0;
      persistState();

      const errorMsg =
        savedCount > 0
          ? `The collection tab was closed — ${savedCount} products were saved.`
          : 'The collection tab was closed.';

      const diagnostic = diagnoseError(errorMsg, {
        code: 'TAB_CLOSED',
        url: closedUrl,
        tabStatus: 'closed',
        preservedCount: savedCount,
      });

      if (closedSessionKey) {
        void updateSessionStatus(
          closedSessionKey,
          'interrupted',
          { collected: savedCount },
          'The collection tab was closed.'
        ).catch(() => {});
      }

      // Notify side panel while preserving saved product count
      browser.runtime
        .sendMessage({
          type: 'UPDATE_PROGRESS',
          payload: {
            collected: savedCount,
            target: 0,
            status: 'error',
            error: errorMsg,
            sessionKey: closedSessionKey,
            diagnostic,
          },
        })
        .catch(() => {});
    }
    });
  });
});
