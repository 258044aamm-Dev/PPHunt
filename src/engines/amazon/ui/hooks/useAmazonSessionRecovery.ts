import { useCallback, useEffect, useState } from 'react';
import {
  getActiveSession,
  updateSessionStatus,
} from '../../db/sessions';
import { isAmazonUrl } from '../../utils/amazon-url';
import { useAmazonCollectionStore } from '../store/collectionStore';

export interface RecoveryNotice {
  type: 'interrupted' | 'tab-closed' | 'page-reloaded';
  message: string;
  collectedCount: number;
  sessionKey?: string;
}

/**
 * On mount, checks for active Amazon sessions in `PPHuntDB` (`sessions` table)
 * and recovers UI state without replacing the currently viewed tab.
 */
export function useAmazonSessionRecovery() {
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);
  const setCollectionTab = useAmazonCollectionStore((s) => s.setCollectionTab);
  const setCurrentSessionKey = useAmazonCollectionStore(
    (s) => s.setCurrentSessionKey,
  );
  const setStatus = useAmazonCollectionStore((s) => s.setStatus);
  const setMode = useAmazonCollectionStore((s) => s.setMode);
  const setTarget = useAmazonCollectionStore((s) => s.setTarget);
  const setCollectedCount = useAmazonCollectionStore(
    (s) => s.setCollectedCount,
  );

  useEffect(() => {
    let cancelled = false;

    const recover = async () => {
      try {
        const activeSession = await getActiveSession();
        if (!activeSession || cancelled) return;

        const sessionKey = activeSession.id;
        const tabId = activeSession.tabId;

        if (typeof tabId === 'number' && tabId > 0) {
          try {
            const tab = await browser.tabs.get(tabId);
            if (
              cancelled ||
              useAmazonCollectionStore.getState().status !== 'idle'
            ) {
              return;
            }

            if (tab?.url && isAmazonUrl(tab.url)) {
              setCollectionTab(tabId, tab.url);
              setCurrentSessionKey(sessionKey);
              setMode(activeSession.mode);
              setTarget(activeSession.targetCount);
              setCollectedCount(activeSession.collectedCount);

              if (activeSession.status === 'paused') {
                setStatus('paused');
              } else {
                setStatus('idle');
                setNotice({
                  type: 'page-reloaded',
                  message: `Previous collection had ${activeSession.collectedCount} products. Page may have reloaded — resume or start fresh?`,
                  collectedCount: activeSession.collectedCount,
                  sessionKey,
                });
              }
              return;
            }
          } catch {
            // Tab no longer exists; fall through to interrupted notice
          }
        }

        if (
          cancelled ||
          useAmazonCollectionStore.getState().status !== 'idle'
        ) {
          return;
        }

        await updateSessionStatus(sessionKey, 'interrupted', {
          collected: activeSession.collectedCount,
          target: activeSession.targetCount,
        });
        setCurrentSessionKey(sessionKey);
        setCollectedCount(activeSession.collectedCount);
        setNotice({
          type: 'tab-closed',
          message: `Previous collection was interrupted — ${activeSession.collectedCount} products were saved.`,
          collectedCount: activeSession.collectedCount,
          sessionKey,
        });
      } catch (err) {
        console.warn('[PPHunt] Session recovery error:', err);
      }
    };

    void recover();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissNotice = useCallback(() => setNotice(null), []);

  const startFresh = useCallback(async () => {
    if (notice?.sessionKey) {
      await updateSessionStatus(notice.sessionKey, 'completed', {
        collected: notice.collectedCount,
      }).catch(() => {});
    }
    setCollectedCount(0);
    setCurrentSessionKey(null);
    setStatus('idle');
    setNotice(null);
  }, [notice, setCollectedCount, setCurrentSessionKey, setStatus]);

  const keepAndResume = useCallback(async () => {
    const store = useAmazonCollectionStore.getState();
    const tabId =
      store.collectionTabId ?? (store.isAmazonPage ? store.activeTabId : null);
    if (tabId !== null) {
      browser.runtime
        .sendMessage({
          type: 'START_COLLECTION',
          payload: {
            mode: store.mode,
            targetCount: store.targetCount,
            tabId,
          },
        })
        .catch(() => {});
      if (notice?.sessionKey) {
        setCurrentSessionKey(notice.sessionKey);
      }
      setStatus('collecting');
    }
    setNotice(null);
  }, [notice?.sessionKey, setCurrentSessionKey, setStatus]);

  return { notice, dismissNotice, startFresh, keepAndResume };
}

export { useAmazonSessionRecovery as useSessionRecovery };
