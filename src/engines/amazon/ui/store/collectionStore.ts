import { create } from 'zustand';
import {
  DEFAULT_AMAZON_SETTINGS,
  clampTargetCount,
} from '../../constants/defaults';
import { diagnoseError } from '../../diagnostics/error-diagnosis';
import type {
  CollectionMode,
  CollectionStatus,
  ErrorDiagnostic,
} from '../../types';

export type { CollectionMode, CollectionStatus };

export interface AmazonCollectionState {
  mode: CollectionMode;
  status: CollectionStatus;
  targetCount: number;
  collectedCount: number;
  errorMessage: string | null;
  errorDiagnostic: ErrorDiagnostic | null;
  activeTabId: number | null;
  activeTabUrl: string | null;
  isAmazonPage: boolean;
  collectionTabId: number | null;
  collectionTabUrl: string | null;
  currentSessionKey: string | null;

  setMode: (mode: CollectionMode) => void;
  setStatus: (status: CollectionStatus) => void;
  setTarget: (count: number) => void;
  setCollectedCount: (count: number) => void;
  setError: (
    message: string | null,
    diagnostic?: ErrorDiagnostic | null,
  ) => void;
  setErrorDiagnostic: (diagnostic: ErrorDiagnostic | null) => void;
  setActiveTab: (
    tabId: number | null,
    url: string | null,
    isAmazon: boolean,
  ) => void;
  setCollectionTab: (tabId: number | null, url: string | null) => void;
  setCurrentSessionKey: (sessionKey: string | null) => void;
  applySettingsDefaults: (defaults: {
    defaultMode: CollectionMode;
    defaultTargetCount: number;
  }) => void;
  prepareForNewExtraction: () => void;
  reset: () => void;
}

const initialState = {
  mode: DEFAULT_AMAZON_SETTINGS.defaultMode as CollectionMode,
  status: 'idle' as CollectionStatus,
  targetCount: DEFAULT_AMAZON_SETTINGS.defaultTargetCount,
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

export const useAmazonCollectionStore = create<AmazonCollectionState>(
  (set, get) => ({
    ...initialState,

    setMode: (mode) => set({ mode }),
    setStatus: (status) => set({ status }),
    setTarget: (targetCount) =>
      set({ targetCount: clampTargetCount(targetCount) }),
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
              targetCount: clampTargetCount(defaults.defaultTargetCount),
            }
          : state,
      ),
    prepareForNewExtraction: () =>
      set({
        status: 'idle',
        collectedCount: 0,
        errorMessage: null,
        errorDiagnostic: null,
        collectionTabId: null,
        collectionTabUrl: null,
        currentSessionKey: null,
      }),
    reset: () => set(initialState),
  }),
);

export {
  useAmazonCollectionStore as useCollectionStore,
  type AmazonCollectionState as CollectionState,
};
