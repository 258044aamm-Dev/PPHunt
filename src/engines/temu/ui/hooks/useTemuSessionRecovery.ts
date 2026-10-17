import { useCallback, useEffect, useState } from 'react';
import { readActiveTemuSession } from '../../db/session-state';
import {
  getActiveTemuSession,
  updateTemuSessionStatus,
} from '../../db/sessions';
import { isTemuUrl } from '../../utils/temu-url';
import { useTemuCollectionStore } from '../store/collectionStore';

export interface TemuRecoveryNotice {
  type: 'interrupted' | 'tab-closed' | 'page-reloaded';
  message: string;
  collectedCount: number;
  sessionId: string;
}

/**
 * On mount, checks for active Temu sessions in `PPHuntTemuDB` and `pphunt.temu.activeSession`
 * and recovers UI state without touching Amazon session state.
 */
export function useTemuSessionRecovery() {
  const [notice, setNotice] = useState<TemuRecoveryNotice | null>(null);
  const setCollectionTab = useTemuCollectionStore((s) => s.setCollectionTab);
  const setCurrentSessionId = useTemuCollectionStore(
    (s) => s.setCurrentSessionId
  );
  const setStatus = useTemuCollectionStore((s) => s.setStatus);
  const setMode = useTemuCollectionStore((s) => s.setMode);
  const setTarget = useTemuCollectionStore((s) => s.setTarget);
  const setCollectedCount = useTemuCollectionStore((s) => s.setCollectedCount);

  useEffect(() => {
    let cancelled = false;

    const recover = async () => {
      try {
        const pointer = await readActiveTemuSession();
        const activeSession = await getActiveTemuSession();
        if (!activeSession || cancelled) return;

        const sessionId = activeSession.sessionId;
        const tabId = pointer?.tabId ?? null;

        if (tabId !== null) {
          try {
            const tab = await browser.tabs.get(tabId);
            if (
              cancelled ||
              useTemuCollectionStore.getState().status !== 'idle'
            ) {
              return;
            }

            if (tab?.url && isTemuUrl(tab.url)) {
              setCollectionTab(tabId, tab.url);
              setCurrentSessionId(sessionId);
              setMode(activeSession.mode);
              setTarget(activeSession.targetCount);
              setCollectedCount(activeSession.collectedCount);

              if (activeSession.status === 'paused') {
                setStatus('paused');
              } else {
                setStatus('idle');
                setNotice({
                  type: 'page-reloaded',
                  message: `Previous Temu collection had ${activeSession.collectedCount} products. Page may have reloaded — resume or start fresh?`,
                  collectedCount: activeSession.collectedCount,
                  sessionId,
                });
              }
              return;
            }
          } catch {
            // Tab no longer exists; fall through to interrupted notice
          }
        }

        if (cancelled || useTemuCollectionStore.getState().status !== 'idle') {
          return;
        }

        await updateTemuSessionStatus(sessionId, 'stopped', {
          collected: activeSession.collectedCount,
          target: activeSession.targetCount,
        });
        setCurrentSessionId(sessionId);
        setCollectedCount(activeSession.collectedCount);
        setNotice({
          type: 'tab-closed',
          message: `Previous Temu collection was interrupted — ${activeSession.collectedCount} products were saved.`,
          collectedCount: activeSession.collectedCount,
          sessionId,
        });
      } catch (err) {
        console.warn('[PPHunt:Temu] Session recovery error:', err);
      }
    };

    void recover();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissNotice = useCallback(() => setNotice(null), []);

  const startFresh = useCallback(async () => {
    if (notice?.sessionId) {
      await updateTemuSessionStatus(notice.sessionId, 'stopped', {
        collected: notice.collectedCount,
      }).catch(() => {});
    }
    setCollectedCount(0);
    setCurrentSessionId(null);
    setStatus('idle');
    setNotice(null);
  }, [notice, setCollectedCount, setCurrentSessionId, setStatus]);

  const keepAndResume = useCallback(async () => {
    const store = useTemuCollectionStore.getState();
    const tabId =
      store.collectionTabId ?? (store.isTemuPage ? store.activeTabId : null);
    if (tabId !== null) {
      browser.runtime
        .sendMessage({
          type: 'TEMU_START_COLLECTION',
          payload: {
            mode: store.mode,
            targetCount: store.targetCount,
            tabId,
            sessionId: notice?.sessionId,
          },
        })
        .catch(() => {});
      if (notice?.sessionId) {
        setCurrentSessionId(notice.sessionId);
      }
      setStatus('collecting');
    }
    setNotice(null);
  }, [notice?.sessionId, setCurrentSessionId, setStatus]);

  return { notice, dismissNotice, startFresh, keepAndResume };
}
