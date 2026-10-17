import { create } from 'zustand';
import type { TemuActiveTab } from '../../types';

interface TemuUIState {
  activeTab: TemuActiveTab;
  settingsOpen: boolean;
  completionDialogOpen: boolean;
  previewOverlayOpen: boolean;
  exportModalOpen: boolean;
  selectedSessionId: string | null;

  setActiveTab: (tab: TemuActiveTab) => void;
  toggleSettings: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openCompletionDialog: (sessionId?: string | null) => void;
  closeCompletionDialog: () => void;
  openPreviewOverlay: (sessionId?: string | null) => void;
  closePreviewOverlay: () => void;
  openExportModal: (sessionId?: string | null) => void;
  closeExportModal: () => void;
  setSelectedSessionId: (sessionId: string | null) => void;
}

export const useTemuUIStore = create<TemuUIState>((set) => ({
  activeTab: 'collect',
  settingsOpen: false,
  completionDialogOpen: false,
  previewOverlayOpen: false,
  exportModalOpen: false,
  selectedSessionId: null,

  setActiveTab: (activeTab) => set({ activeTab }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openCompletionDialog: (sessionId) =>
    set((s) => ({
      completionDialogOpen: true,
      selectedSessionId:
        sessionId !== undefined ? sessionId : s.selectedSessionId,
    })),
  closeCompletionDialog: () => set({ completionDialogOpen: false }),
  openPreviewOverlay: (sessionId) =>
    set((s) => ({
      previewOverlayOpen: true,
      completionDialogOpen: false,
      selectedSessionId:
        sessionId !== undefined ? sessionId : s.selectedSessionId,
    })),
  closePreviewOverlay: () => set({ previewOverlayOpen: false }),
  openExportModal: (sessionId) =>
    set((s) => ({
      exportModalOpen: true,
      selectedSessionId:
        sessionId !== undefined ? sessionId : s.selectedSessionId,
    })),
  closeExportModal: () => set({ exportModalOpen: false }),
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
}));
