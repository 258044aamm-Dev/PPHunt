import { create } from 'zustand';
import { diagnoseError } from '@/lib/diagnostics/error-diagnosis';
import type { ErrorDiagnostic } from '@/types/common';
import { clampTargetCount } from '@/constants/defaults';

export type CollectionMode = 'manual' | 'automatic';
export type CollectionStatus =
  | 'idle'
  | 'collecting'
  | 'paused'
  | 'completed'
  | 'error'
  // L-5 (SAD-197): aligned with types/session.ts. Written to session rows by
  // the background worker (startup reconciliation) and useSessionRecovery.
  | 'interrupted';

interface CollectionState {
  mode: CollectionMode;
  status: CollectionStatus;
  targetCount: number;
  collectedCount: number;
  errorMessage: string | null;
  errorDiagnostic: ErrorDiagnostic | null;
  activeTabId: number | null;
  activeTabUrl: string | null;
  isAmazonPage: boolean;
  // The tab with an ongoing collection can differ from the currently viewed tab.
  collectionTabId: number | null;
  collectionTabUrl: string | null;
  currentSessionKey: string | null;

  setMode: (mode: CollectionMode) => void;
  setStatus: (status: CollectionStatus) => void;
  setTarget: (count: number) => void;
  setCollectedCount: (count: number) => void;
  setError: (
    message: string | null,
    diagnostic?: ErrorDiagnostic | null
  ) => void;
  setErrorDiagnostic: (diagnostic: ErrorDiagnostic | null) => void;
  setActiveTab: (
    tabId: number | null,
    url: string | null,
    isAmazon: boolean
  ) => void;
  setCollectionTab: (tabId: number | null, url: string | null) => void;
  setCurrentSessionKey: (sessionKey: string | null) => void;
  /**
   * H-1 (SAD-167): apply the persisted defaultMode/defaultTargetCount once
   * on startup. Guarded by status === 'idle' so it can never clobber a
   * session that useSessionRecovery has already restored.
   */
  applySettingsDefaults: (defaults: {
    defaultMode: CollectionMode;
    defaultTargetCount: number;
  }) => void;
  reset: () => void;
}

const initialState = {
  mode: 'manual' as CollectionMode,
  status: 'idle' as CollectionStatus,
  targetCount: 50,
  collectedCount: 0,
  errorMessage: null as string | null,
  errorDiagnostic: null as ErrorDiagnostic | null,
  activeTabId: null as number | null,
  activeTabUrl: null as string | null,
  isAmazonPage: false,
  collectionTabId: null as number | null,
  collectionTabUrl: null as string | null,
  currentSessionKey: null as string | null,
};

export const useCollectionStore = create<CollectionState>((set, get) => ({
  ...initialState,

  setMode: (mode) => set({ mode }),
  setStatus: (status) => set({ status }),
  // L-1 (SAD-197): clamp at the single write path so out-of-range values can
  // never reach consumers that divide by targetCount.
  setTarget: (targetCount) => set({ targetCount: clampTargetCount(targetCount) }),
  setCollectedCount: (collectedCount) => set({ collectedCount }),
  setError: (errorMessage, diagnostic) => {
    if (!errorMessage) {
      set({ errorMessage: null, errorDiagnostic: null });
      return;
    }
    const state = get();
    const resolvedDiagnostic =
      diagnostic ??
      diagnoseError(errorMessage, {
        url: state.collectionTabUrl ?? state.activeTabUrl,
        preservedCount: state.collectedCount,
      });
    set({
      errorMessage,
      errorDiagnostic: resolvedDiagnostic,
    });
  },
  setErrorDiagnostic: (errorDiagnostic) => set({ errorDiagnostic }),
  setActiveTab: (tabId, url, isAmazon) =>
    set({ activeTabId: tabId, activeTabUrl: url, isAmazonPage: isAmazon }),
  setCollectionTab: (tabId, url) =>
    set({ collectionTabId: tabId, collectionTabUrl: url }),
  setCurrentSessionKey: (currentSessionKey) => set({ currentSessionKey }),
  applySettingsDefaults: (defaults) =>
    set((state) =>
      state.status === 'idle'
        ? {
            mode: defaults.defaultMode,
            targetCount: defaults.defaultTargetCount,
          }
        : state
    ),
  reset: () => set(initialState),
}));
