import { ErrorBoundary } from '@/entrypoints/sidepanel/components/ErrorBoundary';
import { AmazonCollectTab } from './components/CollectTab';
import { AmazonErrorModal } from './components/ErrorModal';
import { AmazonExtractionCompleteModal } from './components/ExtractionCompleteModal';
import { AmazonFullWidthPreviewModal } from './components/FullWidthPreviewModal';
import { AmazonHistoryTab } from './components/HistoryTab';
import { AmazonNavigation } from './components/Navigation';
import { AmazonSessionNotice } from './components/SessionNotice';
import { AmazonSettingsOverlay } from './components/SettingsOverlay';
import type { RecoveryNotice } from './hooks/useAmazonSessionRecovery';
import { useAmazonUIStore } from './store/uiStore';

export interface AmazonEngineAppProps {
  notice?: RecoveryNotice | null;
  onDismissNotice?: () => void;
  onStartFresh?: () => void;
  onKeepProducts?: () => void;
}

/**
 * Self-contained Amazon engine UI surface rendered inside `App.tsx`
 * when the active marketplace engine is `'amazon'`.
 */
export function AmazonEngineApp({
  notice = null,
  onDismissNotice = () => {},
  onStartFresh,
  onKeepProducts,
}: AmazonEngineAppProps = {}) {
  const activeTab = useAmazonUIStore((s) => s.activeTab);

  const renderTabContent = () => {
    switch (activeTab) {
      case 'collect':
        return <AmazonCollectTab />;
      case 'history':
        return <AmazonHistoryTab />;
    }
  };

  return (
    <>
      <AmazonNavigation />
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'collect' && (
          <AmazonSessionNotice
            notice={notice}
            onDismiss={onDismissNotice}
            onStartFresh={onStartFresh}
            onKeepProducts={onKeepProducts}
          />
        )}
        <ErrorBoundary>{renderTabContent()}</ErrorBoundary>
      </div>
      <AmazonFullWidthPreviewModal />
      <AmazonExtractionCompleteModal />
      <AmazonErrorModal />
      <AmazonSettingsOverlay />
    </>
  );
}
