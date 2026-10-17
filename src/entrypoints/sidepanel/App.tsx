import { useEffect, useRef } from 'react';
import { pruneOldSessions } from '@/lib/db/sessions';
import { Header } from './components/Header';
import { Navigation } from './components/Navigation';
import { CollectTab } from './components/CollectTab';
import { HistoryTab } from './components/HistoryTab';
import { ErrorModal } from './components/ErrorModal';
import { ExtractionCompleteModal } from './components/ExtractionCompleteModal';
import { FullWidthPreviewModal } from './components/FullWidthPreviewModal';
import { SettingsOverlay } from './components/SettingsOverlay';
import { SessionNotice } from './components/SessionNotice';
import { ToastContainer } from './components/ToastContainer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSessionRecovery } from './hooks/useSessionRecovery';
import { useActiveBrowserTab } from './hooks/useActiveBrowserTab';
import { useSettings } from './hooks/useSettings';
import { useUIStore } from './store/uiStore';
import { useCollectionStore } from './store/collectionStore';
import { showToast } from './components/ToastContainer';
import { shouldWarnAboutRejections } from '@/lib/validation-warnings';

/**
 * Main application shell.
 * - Header with theme toggle & settings gear
 * - Navigation tabs (Collect | History)
 * - Tab content
 * - Post-extraction completion dialog & full-width preview overlay
 * - Error modal overlay with comprehensive diagnostics
 * - Settings overlay
 *
 * Keeps the viewed tab in sync as the user navigates or switches tabs.
 */
export default function App({ onClose }: { onClose?: () => void } = {}) {
  const activeTab = useUIStore((s) => s.activeTab);
  const setStatus = useCollectionStore((s) => s.setStatus);
  const setError = useCollectionStore((s) => s.setError);
  const setCollectedCount = useCollectionStore((s) => s.setCollectedCount);
  const setCurrentSessionKey = useCollectionStore((s) => s.setCurrentSessionKey);
  const applySettingsDefaults = useCollectionStore(
    (s) => s.applySettingsDefaults
  );
  const { settings } = useSettings();

  useActiveBrowserTab();

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

  // Render tab content
  // Exhaustive switch over ActiveTab ('collect' | 'history') with no default:
  // if a third tab is ever added, tsc reports the non-exhaustive path instead
  // of silently rendering a stale component.
  const renderTabContent = () => {
    switch (activeTab) {
      case 'collect':
        return <CollectTab />;
      case 'history':
        return <HistoryTab />;
    }
  };

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 flex flex-col">
      <Header onClose={onClose} />
      <div className="border-b border-hairline-soft mb-3" />
      <Navigation />
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'collect' && (
          <SessionNotice
            notice={notice}
            onDismiss={dismissNotice}
            onStartFresh={startFresh}
            onKeepProducts={keepAndResume}
          />
        )}
        {/* M-10 (SAD-169): a tab crash shows the fallback below; header,
            navigation and overlays stay mounted. */}
        <ErrorBoundary>{renderTabContent()}</ErrorBoundary>
      </div>
      <FullWidthPreviewModal />
      <ExtractionCompleteModal />
      <ErrorModal />
      <SettingsOverlay />
      <ToastContainer />
    </div>
  );
}
