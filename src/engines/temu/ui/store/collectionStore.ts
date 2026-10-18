import { create } from 'zustand';
import {
  DEFAULT_TEMU_SETTINGS,
  TEMU_TARGET_MAX,
  TEMU_TARGET_MIN,
} from '../../constants/defaults';
import { diagnoseTemuError } from '../../diagnostics/error-diagnosis';
import type { ErrorDiagnostic } from '@/types/common';
import type { TemuCollectionMode, TemuCollectionStatus } from '../../types';

function clampTemuTarget(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_TEMU_SETTINGS.defaultTargetCount;
  return Math.max(TEMU_TARGET_MIN, Math.min(TEMU_TARGET_MAX, Math.round(count)));
}

interface TemuCollectionState {
  mode: TemuCollectionMode;
  status: TemuCollectionStatus;
  targetCount: number;
  collectedCount: number;
  errorMessage: string | null;
  errorDiagnostic: ErrorDiagnostic | null;
  activeTabId: number | null;
  activeTabUrl: string | null;
  isTemuPage: boolean;
  collectionTabId: number | null;
  collectionTabUrl: string | null;
  currentSessionId: string | null;

  setMode: (mode: TemuCollectionMode) => void;
  setStatus: (status: TemuCollectionStatus) => void;
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
    isTemu: boolean
  ) => void;
  setCollectionTab: (tabId: number | null, url: string | null) => void;
  setCurrentSessionId: (sessionId: string | null) => void;
  applySettingsDefaults: (defaults: {
    defaultMode: TemuCollectionMode;
    defaultTargetCount: number;
  }) => void;
  prepareForNewExtraction: () => void;
  reset: () => void;
}

const initialState = {
  mode: DEFAULT_TEMU_SETTINGS.defaultMode as TemuCollectionMode,
  status: 'idle' as TemuCollectionStatus,
  targetCount: DEFAULT_TEMU_SETTINGS.defaultTargetCount,
  collectedCount: 0,
  errorMessage: null as string | null,
  errorDiagnostic: null as ErrorDiagnostic | null,
  activeTabId: null as number | null,
  activeTabUrl: null as string | null,
  isTemuPage: false,
  collectionTabId: null as number | null,
  collectionTabUrl: null as string | null,
  currentSessionId: null as string | null,
};

export const useTemuCollectionStore = create<TemuCollectionState>(
  (set, get) => ({
    ...initialState,

    setMode: (mode) => set({ mode }),
    setStatus: (status) => set({ status }),
    setTarget: (targetCount) =>
      set({ targetCount: clampTemuTarget(targetCount) }),
    setCollectedCount: (collectedCount) => set({ collectedCount }),
    setError: (errorMessage, diagnostic) => {
      if (!errorMessage) {
        set({ errorMessage: null, errorDiagnostic: null });
        return;
      }
      const state = get();
      const resolvedDiagnostic =
        diagnostic ??
        diagnoseTemuError(errorMessage, {
          url: state.collectionTabUrl ?? state.activeTabUrl,
          preservedCount: state.collectedCount,
        }).diagnostic;
      set({
        errorMessage,
        errorDiagnostic: resolvedDiagnostic,
      });
    },
    setErrorDiagnostic: (errorDiagnostic) => set({ errorDiagnostic }),
    setActiveTab: (tabId, url, isTemu) =>
      set({ activeTabId: tabId, activeTabUrl: url, isTemuPage: isTemu }),
    setCollectionTab: (tabId, url) =>
      set({ collectionTabId: tabId, collectionTabUrl: url }),
    setCurrentSessionId: (currentSessionId) => set({ currentSessionId }),
    applySettingsDefaults: (defaults) =>
      set((state) =>
        state.status === 'idle'
          ? {
              mode: defaults.defaultMode,
              targetCount: clampTemuTarget(defaults.defaultTargetCount),
            }
          : state
      ),
    prepareForNewExtraction: () =>
      set({
        status: 'idle',
        collectedCount: 0,
        errorMessage: null,
        errorDiagnostic: null,
        collectionTabId: null,
        collectionTabUrl: null,
        currentSessionId: null,
      }),
    reset: () => set(initialState),
  })
);
