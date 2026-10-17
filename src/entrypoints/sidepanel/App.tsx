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
          setStatus(status);
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
