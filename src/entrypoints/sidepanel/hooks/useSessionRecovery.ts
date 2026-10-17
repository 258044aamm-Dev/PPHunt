import { useCallback, useEffect, useState } from 'react';
import { getActiveSession, updateSessionStatus } from '@/lib/db/sessions';
import { isAmazonUrl } from '@/lib/utils/amazon-url';
import { useCollectionStore } from '../store/collectionStore';

export interface RecoveryNotice {
  type: 'interrupted' | 'tab-closed' | 'page-reloaded';
  message: string;
  collectedCount: number;
  sessionKey: string;
}

/**
 * On side panel mount, checks for active sessions and attempts recovery.
 *
 * - Finds sessions with status 'collecting' or 'paused'
 * - Checks if the tab still exists via browser.tabs.get
 * - If tab exists + Amazon URL: restores collection UI state
 * - If tab closed/navigated: marks session as 'interrupted', shows notice
 */
export function useSessionRecovery() {
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);
  const setCollectionTab = useCollectionStore((s) => s.setCollectionTab);
  const setStatus = useCollectionStore((s) => s.setStatus);
  const setMode = useCollectionStore((s) => s.setMode);
  const setTarget = useCollectionStore((s) => s.setTarget);
  const setCollectedCount = useCollectionStore((s) => s.setCollectedCount);

  // Check for active session on mount
  useEffect(() => {
    let cancelled = false;

    const recover = async () => {
      try {
        // Step 4.3 (SAD-174): the most RECENT active session, not the
        // lexicographically-lowest primary key ('10_...' < '9_...').
        // Deliberately cross-tab: the side panel persists across tab
        // switches, so recovery must find the run wherever it lives
        // (see Step 4.0 snapshot / active-tab.test.tsx).
        const activeSession = await getActiveSession();

        if (!activeSession || cancelled) return;

        const { tabId, id: sessionKey } = activeSession;

        // Check if the collection tab still exists. Never replace the viewed tab;
        // it is tracked independently as the user navigates.
        try {
          const tab = await browser.tabs.get(tabId);
          if (cancelled || useCollectionStore.getState().status !== 'idle') return;

          if (tab?.url && isAmazonUrl(tab.url)) {
            // Tab exists and is still Amazon — restore collection state
            setCollectionTab(tabId, tab.url);
            setMode(activeSession.mode);
            setTarget(activeSession.targetCount);
            setCollectedCount(activeSession.collectedCount);

            if (activeSession.status === 'paused') {
              setStatus('paused');
            } else {
              setStatus('idle'); // Reset to idle; user can resume or start fresh
              setNotice({
                type: 'page-reloaded',
                message: `Previous collection had ${activeSession.collectedCount} products. Page may have reloaded — resume or start fresh?`,
                collectedCount: activeSession.collectedCount,
                sessionKey,
              });
            }
          } else {
            // Tab exists but navigated away from Amazon
            await updateSessionStatus(sessionKey, 'interrupted', {
              collected: activeSession.collectedCount,
              target: activeSession.targetCount,
            });
            setNotice({
              type: 'tab-closed',
              message: `Collection was interrupted — ${activeSession.collectedCount} products were saved.`,
              collectedCount: activeSession.collectedCount,
              sessionKey,
            });
          }
        } catch {
          if (cancelled || useCollectionStore.getState().status !== 'idle') return;
          // Tab no longer exists
          await updateSessionStatus(sessionKey, 'interrupted', {
            collected: activeSession.collectedCount,
            target: activeSession.targetCount,
          });
          setNotice({
            type: 'tab-closed',
            message: `Collection tab was closed — ${activeSession.collectedCount} products were saved.`,
            collectedCount: activeSession.collectedCount,
            sessionKey,
          });
        }
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
      await updateSessionStatus(notice.sessionKey, 'interrupted', {
        collected: notice.collectedCount,
      }).catch(() => {});
    }
    setCollectedCount(0);
    setStatus('idle');
    setNotice(null);
  }, [notice, setCollectedCount, setStatus]);

  const keepAndResume = useCallback(async () => {
    const store = useCollectionStore.getState();
    const tabId = store.collectionTabId ?? (store.isAmazonPage ? store.activeTabId : null);
    if (tabId !== null) {
      browser.runtime
        .sendMessage({
          type: 'START_COLLECTION',
          payload: {
            mode: store.mode,
            targetCount: store.targetCount,
            tabId,
            sessionKey: notice?.sessionKey,
          },
        })
        .catch(() => {});
      setStatus('collecting');
    }
    setNotice(null);
  }, [notice?.sessionKey, setStatus]);

  return { notice, dismissNotice, startFresh, keepAndResume };
}
