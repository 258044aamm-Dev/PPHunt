import { useCallback, useEffect, useRef } from 'react';
import { ErrorBoundary } from '@/entrypoints/sidepanel/components/ErrorBoundary';
import { showToast } from '@/entrypoints/sidepanel/components/ToastContainer';
import { pruneOldTemuSessions } from '../db/sessions';
import { diagnoseTemuError } from '../diagnostics/error-diagnosis';
import { validateTemuSidepanelIncomingMessage } from '../schemas/validate-message';
import type { TemuActiveTab } from '../types';
import { TemuCollectTab } from './components/CollectTab';
import { TemuErrorModal } from './components/ErrorModal';
import { TemuExtractionCompleteModal } from './components/ExtractionCompleteModal';
import { TemuFullWidthPreviewModal } from './components/FullWidthPreviewModal';
import { TemuHistoryTab } from './components/HistoryTab';
import { TemuSettingsOverlay } from './components/SettingsOverlay';
import { useTemuActiveTab } from './hooks/useTemuActiveTab';
import { useTemuSessionRecovery } from './hooks/useTemuSessionRecovery';
import { useTemuSettings } from './hooks/useTemuSettings';
import { useTemuCollectionStore } from './store/collectionStore';
import { useTemuUIStore } from './store/uiStore';

const TABS: { key: TemuActiveTab; label: string }[] = [
  { key: 'collect', label: 'Collect' },
  { key: 'history', label: 'History' },
];

export function TemuEngineApp() {
  const activeTab = useTemuUIStore((s) => s.activeTab);
  const setActiveTab = useTemuUIStore((s) => s.setActiveTab);
  const setStatus = useTemuCollectionStore((s) => s.setStatus);
  const setError = useTemuCollectionStore((s) => s.setError);
  const setCollectedCount = useTemuCollectionStore((s) => s.setCollectedCount);
  const setCurrentSessionId = useTemuCollectionStore(
    (s) => s.setCurrentSessionId
  );
  const applySettingsDefaults = useTemuCollectionStore(
    (s) => s.applySettingsDefaults
  );
  const { settings } = useTemuSettings();

  useTemuActiveTab();

  const defaultsAppliedRef = useRef(false);
  useEffect(() => {
    void pruneOldTemuSessions().catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings || defaultsAppliedRef.current) return;
    defaultsAppliedRef.current = true;
    applySettingsDefaults({
      defaultMode: settings.defaultMode,
      defaultTargetCount: settings.defaultTargetCount,
    });
  }, [settings, applySettingsDefaults]);

  const notificationsRef = useRef(false);
  useEffect(() => {
    notificationsRef.current = Boolean(settings?.soundNotifications);
  }, [settings?.soundNotifications]);

  const { notice, dismissNotice, startFresh, keepAndResume } =
    useTemuSessionRecovery();

  useEffect(() => {
    const handler = (rawMessage: unknown) => {
      const msg = validateTemuSidepanelIncomingMessage(rawMessage);
      if (!msg) return;

      switch (msg.type) {
        case 'TEMU_PRODUCTS_SCRAPED': {
          const { totalCollected, sessionId } = msg.payload;
          setCurrentSessionId(sessionId);
          setCollectedCount(totalCollected);
          const storeState = useTemuCollectionStore.getState();
          const isStaleAfterCompletion =
            storeState.status === 'completed' &&
            storeState.collectionTabId === null &&
            useTemuUIStore.getState().completionDialogOpen;
          if (!isStaleAfterCompletion) {
            setStatus('collecting');
          }
          break;
        }

        case 'TEMU_COLLECTION_PROGRESS': {
          const { collectedCount, status } = msg.payload;
          setCollectedCount(collectedCount);
          const storeState = useTemuCollectionStore.getState();
          const isStaleCollectingAfterCompletion =
            status === 'collecting' &&
            storeState.status === 'completed' &&
            storeState.collectionTabId === null &&
            useTemuUIStore.getState().completionDialogOpen;
          if (!isStaleCollectingAfterCompletion) {
            setStatus(status);
          }
          break;
        }

        case 'TEMU_COLLECTION_STATUS': {
          const { status, collectedCount, sessionId } = msg.payload;
          if (sessionId) setCurrentSessionId(sessionId);
          setCollectedCount(collectedCount);
          if (
            status === 'completed' ||
            status === 'stopped' ||
            status === 'idle'
          ) {
            useTemuCollectionStore.getState().setCollectionTab(null, null);
          }
          setStatus(status);
          if (status === 'completed') {
            const resolvedSessionId =
              sessionId ?? useTemuCollectionStore.getState().currentSessionId;
            useTemuUIStore.getState().openCompletionDialog(resolvedSessionId);
            if (collectedCount > 0 && notificationsRef.current) {
              showToast(
                'success',
                `${collectedCount} Temu products collected`,
                'Ready to preview or export.'
              );
            }
          }
          break;
        }

        case 'TEMU_COLLECTION_ERROR': {
          useTemuUIStore.getState().closeCompletionDialog();
          const { diagnostic } = diagnoseTemuError(msg.payload, {
            code: msg.payload.code,
            category: msg.payload.category,
            title: msg.payload.title,
            remedy: msg.payload.remedy,
            preservedCount: useTemuCollectionStore.getState().collectedCount,
          });
          setStatus('error');
          setError(msg.payload.message, diagnostic);
          if (notificationsRef.current) {
            showToast('error', msg.payload.title, msg.payload.message);
          }
          break;
        }

        case 'TEMU_PAGE_STATUS':
          break;
      }
    };

    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, [setCollectedCount, setStatus, setError, setCurrentSessionId]);

  const handleNavKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = TABS.findIndex((t) => t.key === activeTab);
      let nextIndex: number | null = null;

      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % TABS.length;
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
      }

      const nextTab = nextIndex !== null ? TABS[nextIndex] : undefined;
      if (nextTab) {
        e.preventDefault();
        setActiveTab(nextTab.key);
      }
    },
    [activeTab, setActiveTab]
  );

  return (
    <>
      <nav
        className="flex gap-6 mb-4 border-b border-hairline-soft"
        role="tablist"
        onKeyDown={handleNavKeyDown}
      >
        {TABS.map(({ key, label }) => {
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`temu-panel-${key}`}
              id={`temu-tab-${key}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(key)}
              className={`
                font-sans text-sm font-medium pb-2 -mb-px transition-colors
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay rounded-t-sm
                ${
                  isActive
                    ? 'text-ink border-b-2 border-clay'
                    : 'text-ink-muted hover:text-ink border-b-2 border-transparent'
                }
              `}
            >
              {label}
            </button>
          );
        })}
      </nav>

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        role="tabpanel"
        id={`temu-panel-${activeTab}`}
        aria-labelledby={`temu-tab-${activeTab}`}
      >
        {activeTab === 'collect' && notice && (
          <div className="bg-surface-card border border-golden rounded-md p-3.5 mb-3">
            <p className="font-serif text-xs text-ink mb-2 leading-relaxed">
              {notice.message}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={keepAndResume}
                className="px-3 py-1 font-sans text-xs font-medium bg-clay text-clay-ink rounded-sm hover:bg-clay-active transition-colors"
              >
                Keep & Resume
              </button>
              <button
                type="button"
                onClick={startFresh}
                className="px-3 py-1 font-sans text-xs text-ink border border-hairline rounded-sm hover:bg-surface-soft transition-colors"
              >
                Start Fresh
              </button>
              <button
                type="button"
                onClick={dismissNotice}
                className="px-2 py-1 font-sans text-xs text-ink-muted hover:text-ink transition-colors ml-auto"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <ErrorBoundary>
          {activeTab === 'collect' ? <TemuCollectTab /> : <TemuHistoryTab />}
        </ErrorBoundary>
      </div>

      <TemuFullWidthPreviewModal />
      <TemuExtractionCompleteModal />
      <TemuErrorModal />
      <TemuSettingsOverlay />
    </>
  );
}
