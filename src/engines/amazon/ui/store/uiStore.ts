import { create } from 'zustand';

export type ActiveTab = 'collect' | 'history';

export interface AmazonUIState {
  activeTab: ActiveTab;
  settingsOpen: boolean;
  completionDialogOpen: boolean;
  previewOverlayOpen: boolean;
  exportModalOpen: boolean;
  selectedSessionKey: string | null;

  setActiveTab: (tab: ActiveTab) => void;
  toggleSettings: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openCompletionDialog: (sessionKey?: string | null) => void;
  closeCompletionDialog: () => void;
  openPreviewOverlay: (sessionKey?: string | null) => void;
  closePreviewOverlay: () => void;
  openExportModal: (sessionKey?: string | null) => void;
  closeExportModal: () => void;
  setSelectedSessionKey: (sessionKey: string | null) => void;
}

export const useAmazonUIStore = create<AmazonUIState>((set) => ({
  activeTab: 'collect',
  settingsOpen: false,
  completionDialogOpen: false,
  previewOverlayOpen: false,
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
  openPreviewOverlay: (sessionKey) =>
    set((s) => ({
      previewOverlayOpen: true,
      completionDialogOpen: false,
      selectedSessionKey:
        sessionKey !== undefined ? sessionKey : s.selectedSessionKey,
    })),
  closePreviewOverlay: () => set({ previewOverlayOpen: false }),
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
