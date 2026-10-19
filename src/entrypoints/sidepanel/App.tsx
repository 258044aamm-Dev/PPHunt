import { useEffect, useRef, useState, useCallback } from 'react';
import { pruneOldSessions } from '@/lib/db/sessions';
import { detectOverlayEngine } from '@/lib/overlay/openOverlay';
import { Header, type MarketplaceEngineId } from './components/Header';
import { ToastContainer, showToast } from './components/ToastContainer';
import { useSessionRecovery } from './hooks/useSessionRecovery';
import { useActiveBrowserTab } from './hooks/useActiveBrowserTab';
import { useSettings } from './hooks/useSettings';
import { useUIStore } from './store/uiStore';
import { useCollectionStore } from './store/collectionStore';
import { useTemuUIStore } from '@/engines/temu/ui/store/uiStore';
import { TemuEngineApp } from '@/engines/temu/ui/TemuEngineApp';
import { AmazonEngineApp } from '@/engines/amazon/ui/AmazonEngineApp';
import { shouldWarnAboutRejections } from '@/lib/validation-warnings';

/**
 * Main application shell supporting two isolated marketplace engines:
 * - Amazon (`PPHuntDB`, standard messages, `AmazonEngineApp`)
 * - Temu (`PPHuntTemuDB`, `TEMU_*` messages, `TemuEngineApp`)
 *
 * Auto-selects Amazon on `amazon.*` tabs and Temu on `temu.com` tabs, while
 * allowing manual switching via the `Amazon | Temu` pill toggle in the Header.
 */
export default function App({ onClose }: { onClose?: () => void } = {}) {
  const [activeEngine, setActiveEngine] = useState<MarketplaceEngineId>('amazon');
  const lastAutoDetectedUrlRef = useRef<string | null>(null);

  const openAmazonSettings = useUIStore((s) => s.openSettings);
  const openTemuSettings = useTemuUIStore((s) => s.openSettings);
  const setStatus = useCollectionStore((s) => s.setStatus);
  const setError = useCollectionStore((s) => s.setError);
  const setCollectedCount = useCollectionStore((s) => s.setCollectedCount);
  const setCurrentSessionKey = useCollectionStore((s) => s.setCurrentSessionKey);
  const applySettingsDefaults = useCollectionStore(
    (s) => s.applySettingsDefaults
  );
  const { settings } = useSettings();

  useActiveBrowserTab();

  // Auto-detect marketplace engine from active browser tab URL on mount and tab changes
  useEffect(() => {
    let mounted = true;

    const syncEngineFromUrl = (url: string | undefined) => {
      if (!mounted || !url) return;
      if (lastAutoDetectedUrlRef.current === url) return;
      const detected = detectOverlayEngine(url);
      if (detected) {
        lastAutoDetectedUrlRef.current = url;
        setActiveEngine(detected);
      }
    };

    const checkCurrentTab = async () => {
      try {
        const tabs = await browser?.tabs?.query?.({
          active: true,
          currentWindow: true,
        });
        syncEngineFromUrl(tabs?.[0]?.url);
      } catch {
        // Ignore in test environments without full tabs API
      }
    };

    void checkCurrentTab();

    const handleActivated = (activeInfo: { tabId: number }) => {
      browser?.tabs
        ?.get?.(activeInfo.tabId)
        .then((tab) => {
          lastAutoDetectedUrlRef.current = null;
          syncEngineFromUrl(tab?.url);
        })
        .catch(() => {});
    };

    const handleUpdated = (
      _tabId: number,
      changeInfo: { url?: string; status?: string },
      tab: { active?: boolean; url?: string }
    ) => {
      if (!tab?.active) return;
      if (changeInfo.url || changeInfo.status === 'complete') {
        syncEngineFromUrl(changeInfo.url ?? tab.url);
      }
    };

    browser?.tabs?.onActivated?.addListener?.(handleActivated);
    browser?.tabs?.onUpdated?.addListener?.(handleUpdated);

    return () => {
      mounted = false;
      browser?.tabs?.onActivated?.removeListener?.(handleActivated);
      browser?.tabs?.onUpdated?.removeListener?.(handleUpdated);
    };
  }, []);

  // H-1 (SAD-167): persisted defaultMode/defaultTargetCount take effect on
  // startup. Applied once, and the store action itself refuses to touch a
  // non-idle collection (session recovery wins).
  const defaultsAppliedRef = useRef(false);
  // Step 4.3 (SAD-174): prune terminal sessions once per panel open
  // (mount effect, not the render path).
  useEffect(() => {
    void pruneOldSessions().catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings || defaultsAppliedRef.current) return;
    defaultsAppliedRef.current = true;
    applySettingsDefaults({
      defaultMode: settings.defaultMode,
      defaultTargetCount: settings.defaultTargetCount,
    });
  }, [settings, applySettingsDefaults]);

  // H-1 (SAD-167): the notifications toggle gates in-panel toasts.
  // Deliberate scope decision (SAD-167): no chrome.notifications permission —
  // it would add an update-time permission prompt for little gain; spec/06
  // is amended to record the reduction. Ref keeps the async handler current.
  const notificationsRef = useRef(true);
  useEffect(() => {
    notificationsRef.current = settings?.notifications !== false;
  }, [settings?.notifications]);

  // SAD-343: a save notification only makes sense for the engine whose History
  // the user is looking at. Mirrored into a ref so the message listener below
  // does not have to re-register every time the engine toggles.
  const activeEngineRef = useRef<MarketplaceEngineId>('amazon');
  useEffect(() => {
    activeEngineRef.current = activeEngine;
  }, [activeEngine]);

  // SAD-343: one toast per save job. `completed` is emitted once per job, but a
  // resumed worker or a reopened panel could replay it; this keeps the panel
  // from stacking duplicates. Bounded so a long session cannot grow it forever.
  const announcedSaveJobsRef = useRef<Set<string>>(new Set());

  // Session recovery — check for interrupted sessions on mount
  const { notice, dismissNotice, startFresh, keepAndResume } =
    useSessionRecovery();

  // Listen for progress updates from background
  useEffect(() => {
    const handler = (message: unknown) => {
      const msg = message as { type?: string; payload?: any };
      if (msg?.type === 'UPDATE_PROGRESS' && msg.payload) {
        const {
          collected,
          status,
          error,
          sessionKey,
          diagnostic,
          rejected,
          rejectedOf,
        } = msg.payload;
        if (typeof sessionKey === 'string' && sessionKey.length > 0) {
          setCurrentSessionKey(sessionKey);
        }
        if (typeof collected === 'number') {
          const currentCount = useCollectionStore.getState().collectedCount;
          // Preserve existing collected count if an error arrives with collected: 0
          if (collected > 0 || status !== 'error' || currentCount === 0) {
            setCollectedCount(collected);
          }
        }
        if (status) {
          const storeState = useCollectionStore.getState();
          const isStaleCollectingAfterCompletion =
            status === 'collecting' &&
            storeState.status === 'completed' &&
            storeState.collectionTabId === null &&
            useUIStore.getState().completionDialogOpen;

          if (
            status === 'completed' ||
            status === 'stopped' ||
            status === 'idle'
          ) {
            storeState.setCollectionTab(null, null);
          }

          if (!isStaleCollectingAfterCompletion) {
            setStatus(status);
          }

          if (status === 'completed' && !error) {
            const resolvedSessionKey =
              sessionKey ?? useCollectionStore.getState().currentSessionKey;
            useUIStore.getState().openCompletionDialog(resolvedSessionKey);
            if (collected > 0 && notificationsRef.current) {
              showToast(
                'success',
                `${collected} products collected`,
                'Ready to preview or export.'
              );
            }
          } else if (status === 'error') {
            useUIStore.getState().closeCompletionDialog();
          }
        }
        if (error) {
          useUIStore.getState().closeCompletionDialog();
          setError(error, diagnostic ?? null);
          const toastTitle = diagnostic?.title ?? 'Collection error';
          if (notificationsRef.current) {
            showToast('error', toastTitle, error);
          }
        }
        // M-7 (SAD-180): silent product drops are visible now — when more
        // than 10% of a batch fails schema validation, raise a non-fatal
        // attention toast. Gated by the notifications setting like every
        // other in-panel toast (SAD-167 scope decision).
        if (
          shouldWarnAboutRejections(rejected, rejectedOf, notificationsRef.current)
        ) {
          showToast(
            'attention',
            `${rejected} of ${rejectedOf} products failed validation`,
            'They were skipped — details in the console log.'
          );
        }
      }
    };

    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, [setCollectedCount, setStatus, setError, setCurrentSessionKey]);

  // SAD-343: quick saves were invisible in the panel — the background already
  // broadcasts SAVE_JOB_UPDATE, nothing listened. This renders panel-only
  // feedback for a finished save; it never re-broadcasts to the page, which
  // keeps showing its own toast from the content script.
  useEffect(() => {
    const MAX_ANNOUNCED_JOBS = 50;

    /**
     * SAD-343: true when `tabId` is the tab the user is actually looking at —
     * i.e. the Amazon page is on screen and its content script is already
     * showing the save toast. Unknown counts as "not visible", because a
     * duplicate is better than silently dropping the only feedback.
     */
    const isWatchedTab = async (tabId: number): Promise<boolean> => {
      try {
        const tabs = await browser?.tabs?.query?.({
          active: true,
          currentWindow: true,
        });
        return Array.isArray(tabs) && tabs[0]?.id === tabId;
      } catch {
        return false;
      }
    };

    const handleSaveJobUpdate = async (payload: {
      jobId?: unknown;
      state?: unknown;
      warning?: unknown;
      productTitle?: unknown;
      tabId?: unknown;
    }) => {
      // Card states (extracting / enriching / failed) are the card's job; the
      // panel only reports the terminal, user-meaningful one.
      if (payload.state !== 'completed') return;
      if (activeEngineRef.current !== 'amazon') return;
      // Same gate as every other in-panel toast (SAD-167 scope decision).
      if (!notificationsRef.current) return;

      const jobId = typeof payload.jobId === 'string' ? payload.jobId : null;
      if (jobId) {
        const announced = announcedSaveJobsRef.current;
        if (announced.has(jobId)) return;
        announced.add(jobId);
        if (announced.size > MAX_ANNOUNCED_JOBS) {
          const oldest = announced.values().next().value;
          if (oldest !== undefined) announced.delete(oldest);
        }
      }

      // SAD-343: never duplicate the page toast. When the saving tab is the
      // active tab of this window, that page is on screen and already showed
      // the save — stay quiet. In every other case (panel on another tab or in
      // another window) the panel is the only place the result is visible.
      const savingTabId =
        typeof payload.tabId === 'number' ? payload.tabId : undefined;
      if (savingTabId !== undefined && (await isWatchedTab(savingTabId))) {
        return;
      }

      // Exactly one toast per save: the warning, when present, *is* the toast
      // rather than a second one on top of a success.
      const warning = typeof payload.warning === 'string' ? payload.warning : '';
      if (warning) {
        showToast('attention', 'Saved, but the product details are incomplete', warning);
        return;
      }

      const title =
        typeof payload.productTitle === 'string' && payload.productTitle
          ? payload.productTitle
          : undefined;
      showToast('success', 'Saved to History', title);
    };

    const handler = (message: unknown) => {
      const msg = message as { type?: string; payload?: unknown };
      if (msg?.type !== 'SAVE_JOB_UPDATE' || !msg.payload) return;
      if (typeof msg.payload !== 'object') return;
      void handleSaveJobUpdate(
        msg.payload as {
          jobId?: unknown;
          state?: unknown;
          warning?: unknown;
          productTitle?: unknown;
          tabId?: unknown;
        },
      );
    };

    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  const handleEngineChange = useCallback((engine: MarketplaceEngineId) => {
    setActiveEngine(engine);
  }, []);

  const handleOpenSettings = useCallback(() => {
    if (activeEngine === 'temu') {
      openTemuSettings();
    } else {
      openAmazonSettings();
    }
  }, [activeEngine, openTemuSettings, openAmazonSettings]);

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 flex flex-col">
      <Header
        onClose={onClose}
        activeEngine={activeEngine}
        onEngineChange={handleEngineChange}
        onOpenSettings={handleOpenSettings}
      />
      <div className="border-b border-hairline-soft mb-3" />
      {activeEngine === 'temu' ? (
        <TemuEngineApp />
      ) : (
        <AmazonEngineApp
          notice={notice}
          onDismissNotice={dismissNotice}
          onStartFresh={startFresh}
          onKeepProducts={keepAndResume}
        />
      )}
      <ToastContainer />
    </div>
  );
}
