import { useCollectionStore } from '../store/collectionStore';
import { useUIStore } from '../store/uiStore';
import {
  createSession,
  getSession,
  updateSessionStatus,
} from '@/lib/db/sessions';
import { addHistory } from '@/lib/db/history';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';

// Track current session key across the component lifecycle
let currentSessionKey: string | null = null;

type ControlAction = 'start' | 'pause' | 'resume' | 'stop';

interface ControlButton {
  action: ControlAction;
  label: string;
  icon: string;
  isPrimary: boolean;
  isVisible: (status: string) => boolean;
  isEnabled: (status: string, isAmazon: boolean) => boolean;
}

const CONTROLS: ControlButton[] = [
  {
    action: 'start',
    label: 'Start',
    icon: '▶',
    isPrimary: true,
    isVisible: (s) => s === 'idle' || s === 'completed' || s === 'error',
    isEnabled: (s, isAmazon) => isAmazon && (s === 'idle' || s === 'completed' || s === 'error'),
  },
  {
    action: 'pause',
    label: 'Pause',
    icon: '⏸',
    isPrimary: false,
    isVisible: (s) => s === 'collecting',
    isEnabled: (s) => s === 'collecting',
  },
  {
    action: 'resume',
    label: 'Resume',
    icon: '▶',
    isPrimary: true,
    isVisible: (s) => s === 'paused',
    isEnabled: (s) => s === 'paused',
  },
  {
    action: 'stop',
    label: 'Stop',
    icon: '⏹',
    isPrimary: false,
    isVisible: (s) => s === 'collecting' || s === 'paused',
    isEnabled: (s) => s === 'collecting' || s === 'paused',
  },
];

/**
 * Start / Pause / Resume / Stop controls.
 * - Start: clay CTA, only enabled on Amazon pages when idle/completed/error
 * - Pause: shown during collection
 * - Resume: primary clay CTA shown when paused
 * - Stop: shown during collection/paused
 */
export function CollectionControls() {
  const status = useCollectionStore((s) => s.status);
  const isAmazonPage = useCollectionStore((s) => s.isAmazonPage);
  const mode = useCollectionStore((s) => s.mode);
  const targetCount = useCollectionStore((s) => s.targetCount);
  const activeTabId = useCollectionStore((s) => s.activeTabId);
  const collectionTabId = useCollectionStore((s) => s.collectionTabId);

  const handleAction = async (action: ControlAction) => {
    const store = useCollectionStore.getState();
    const uiStore = useUIStore.getState();

    switch (action) {
      case 'start': {
        if (!store.isAmazonPage || store.activeTabId === null || !store.activeTabUrl) return;
        const tabId = store.activeTabId;
        const url = store.activeTabUrl;

        // Close any open post-extraction dialogs before starting a new extraction
        uiStore.closeCompletionDialog();
        uiStore.closePreviewOverlay();
        setOverlayFullWidthMode(false);

        currentSessionKey = await createSession(tabId, url, mode, targetCount);
        store.setCollectionTab(tabId, url);
        store.setCurrentSessionKey(currentSessionKey);
        store.setError(null);

        browser.runtime.sendMessage({
          type: 'START_COLLECTION',
          payload: { mode, targetCount, tabId, sessionKey: currentSessionKey },
        });
        store.setStatus('collecting');
        store.setCollectedCount(0);
        break;
      }

      case 'pause':
        if (store.collectionTabId === null) return;
        browser.runtime.sendMessage({
          type: 'PAUSE_COLLECTION',
          payload: { tabId: store.collectionTabId },
        });
        store.setStatus('paused');
        if (currentSessionKey) {
          await updateSessionStatus(currentSessionKey, 'paused', {
            collected: store.collectedCount,
            target: targetCount,
          });
        }
        break;

      case 'resume':
        if (store.collectionTabId === null) return;
        browser.runtime.sendMessage({
          type: 'RESUME_COLLECTION',
          payload: { tabId: store.collectionTabId },
        });
        store.setStatus('collecting');
        if (currentSessionKey) {
          await updateSessionStatus(currentSessionKey, 'collecting', {
            collected: store.collectedCount,
            target: targetCount,
          });
        }
        break;

      case 'stop': {
        if (store.collectionTabId === null) return;
        const stoppedSessionKey = currentSessionKey ?? store.currentSessionKey;
        browser.runtime.sendMessage({
          type: 'STOP_COLLECTION',
          payload: { tabId: store.collectionTabId },
        });
        store.setStatus('completed');
        uiStore.openCompletionDialog();

        // Write history for the collection tab, not a different tab now in view.
        if (stoppedSessionKey) {
          const now = new Date().toISOString();
          // Step 4.1 (SAD-172): read the REAL start time from the session row
          // written by createSession — previously both timestamps were `now`,
          // so every History row reported a zero-duration run and the UI
          // showed the end time labelled as the start.
          const session = await getSession(stoppedSessionKey);
          await updateSessionStatus(stoppedSessionKey, 'completed', {
            collected: store.collectedCount,
            target: targetCount,
          });
          await addHistory({
            sessionKey: stoppedSessionKey,
            url: store.collectionTabUrl ?? '',
            mode,
            targetCount,
            collectedCount: store.collectedCount,
            startedAt: session?.startedAt ?? now,
            completedAt: now,
            status: 'completed',
          });
          currentSessionKey = null;
        }
        store.setCollectionTab(null, null);
        break;
      }
    }
  };

  return (
    <div className="flex gap-2.5 flex-wrap pt-1">
      {CONTROLS.filter((c) => c.isVisible(status)).map((ctrl) => {
        const enabled = ctrl.isEnabled(status, isAmazonPage) &&
          (ctrl.action === 'start' ? activeTabId !== null : collectionTabId !== null);
        return (
          <button
            key={ctrl.action}
            type="button"
            onClick={() => handleAction(ctrl.action)}
            disabled={!enabled}
            className={`
              px-5 py-2.5 font-sans text-sm rounded-sm transition-colors
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
              ${
                ctrl.isPrimary
                  ? 'bg-clay text-clay-ink font-medium hover:bg-clay-active border border-transparent'
                  : 'bg-surface text-ink border border-hairline hover:bg-surface-soft'
              }
              ${!enabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            {ctrl.icon} {ctrl.label}
          </button>
        );
      })}
    </div>
  );
}
