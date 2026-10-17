import { useAmazonUIStore } from './store/uiStore';
import { Navigation } from './components/Navigation';
import { CollectTab } from './components/CollectTab';
import { HistoryTab } from './components/HistoryTab';
import { ErrorModal } from './components/ErrorModal';
import { ExtractionCompleteModal } from './components/ExtractionCompleteModal';
import { FullWidthPreviewModal } from './components/FullWidthPreviewModal';
import { SettingsOverlay } from './components/SettingsOverlay';
import { SessionNotice } from './components/SessionNotice';
import { ErrorBoundary } from '@/entrypoints/sidepanel/components/ErrorBoundary';
import type { RecoveryNotice } from './hooks/useAmazonSessionRecovery';

export interface AmazonEngineAppProps {
  notice?: RecoveryNotice | null;
  onDismissNotice?: () => void;
  onStartFresh?: () => void;
  onKeepProducts?: () => void;
}

/**
 * Isolated Amazon marketplace engine UI shell.
 * Renders the 2-tab layout (Collect | History), session recovery notice,
 * error boundary, and 4 modal overlays with 100% visual parity.
 */
export function AmazonEngineApp({
  notice = null,
  onDismissNotice = () => {},
  onStartFresh = () => {},
  onKeepProducts = () => {},
}: AmazonEngineAppProps = {}) {
  const activeTab = useAmazonUIStore((s) => s.activeTab);

  // Exhaustive switch over ActiveTab ('collect' | 'history') with no default
  const renderTabContent = () => {
    switch (activeTab) {
      case 'collect':
        return <CollectTab />;
      case 'history':
        return <HistoryTab />;
    }
  };

  return (
    <>
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
            onDismiss={onDismissNotice}
            onStartFresh={onStartFresh}
            onKeepProducts={onKeepProducts}
          />
        )}
        <ErrorBoundary>{renderTabContent()}</ErrorBoundary>
      </div>
      <FullWidthPreviewModal />
      <ExtractionCompleteModal />
      <ErrorModal />
      <SettingsOverlay />
    </>
  );
}
