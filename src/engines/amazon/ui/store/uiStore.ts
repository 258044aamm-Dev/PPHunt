import { create } from 'zustand';
import type { SortingState } from '@tanstack/react-table';

export type ActiveTab = 'collect' | 'history';
export type PreviewSurfaceMode = 'sidebar' | 'overview';

export interface AmazonUIState {
  activeTab: ActiveTab;
  settingsOpen: boolean;
  completionDialogOpen: boolean;
  previewOverlayOpen: boolean;
  previewMode: PreviewSurfaceMode;
  previewSorting: SortingState;
  previewGlobalFilter: string;
  exportModalOpen: boolean;
  selectedSessionKey: string | null;

  setActiveTab: (tab: ActiveTab) => void;
  toggleSettings: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openCompletionDialog: (sessionKey?: string | null) => void;
  closeCompletionDialog: () => void;
  openPreviewOverlay: (
    sessionKey?: string | null,
    mode?: PreviewSurfaceMode,
  ) => void;
  closePreviewOverlay: () => void;
  setPreviewMode: (mode: PreviewSurfaceMode) => void;
  setPreviewSorting: (sorting: SortingState) => void;
  setPreviewGlobalFilter: (filter: string) => void;
  openExportModal: (sessionKey?: string | null) => void;
  closeExportModal: () => void;
  setSelectedSessionKey: (sessionKey: string | null) => void;
}

export const useAmazonUIStore = create<AmazonUIState>((set) => ({
  activeTab: 'collect',
  settingsOpen: false,
  completionDialogOpen: false,
  previewOverlayOpen: false,
  previewMode: 'overview',
  previewSorting: [],
  previewGlobalFilter: '',
  exportModalOpen: false,
  selectedSessionKey: null,

  setActiveTab: (activeTab) => set({ activeTab }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openCompletionDialog: (sessionKey) =>
    set((s) => ({
      completionDialogOpen: true,
      selectedSessionKey:
        sessionKey !== undefined ? sessionKey : s.selectedSessionKey,
    })),
  closeCompletionDialog: () => set({ completionDialogOpen: false }),
  openPreviewOverlay: (sessionKey, mode) =>
    set((s) => ({
      previewOverlayOpen: true,
      previewMode: mode ?? s.previewMode,
      completionDialogOpen: false,
      selectedSessionKey:
        sessionKey !== undefined ? sessionKey : s.selectedSessionKey,
    })),
  closePreviewOverlay: () => set({ previewOverlayOpen: false }),
  setPreviewMode: (previewMode) => set({ previewMode }),
  setPreviewSorting: (previewSorting) => set({ previewSorting }),
  setPreviewGlobalFilter: (previewGlobalFilter) => set({ previewGlobalFilter }),
  openExportModal: (sessionKey) =>
    set((s) => ({
      exportModalOpen: true,
      selectedSessionKey:
        sessionKey !== undefined ? sessionKey : s.selectedSessionKey,
    })),
  closeExportModal: () => set({ exportModalOpen: false }),
  setSelectedSessionKey: (selectedSessionKey) => set({ selectedSessionKey }),
}));

export {
  useAmazonUIStore as useUIStore,
  type AmazonUIState as UIState,
};
