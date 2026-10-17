import { create } from 'zustand';
import type { SortingState } from '@tanstack/react-table';
import type { TemuActiveTab } from '../../types';
import type { PreviewSurfaceMode } from '@/entrypoints/sidepanel/store/uiStore';

interface TemuUIState {
  activeTab: TemuActiveTab;
  settingsOpen: boolean;
  completionDialogOpen: boolean;
  previewOverlayOpen: boolean;
  previewMode: PreviewSurfaceMode;
  previewSorting: SortingState;
  previewGlobalFilter: string;
  exportModalOpen: boolean;
  selectedSessionId: string | null;

  setActiveTab: (tab: TemuActiveTab) => void;
  toggleSettings: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openCompletionDialog: (sessionId?: string | null) => void;
  closeCompletionDialog: () => void;
  openPreviewOverlay: (
    sessionId?: string | null,
    mode?: PreviewSurfaceMode,
  ) => void;
  closePreviewOverlay: () => void;
  setPreviewMode: (mode: PreviewSurfaceMode) => void;
  setPreviewSorting: (sorting: SortingState) => void;
  setPreviewGlobalFilter: (filter: string) => void;
  openExportModal: (sessionId?: string | null) => void;
  closeExportModal: () => void;
  setSelectedSessionId: (sessionId: string | null) => void;
}

export const useTemuUIStore = create<TemuUIState>((set) => ({
  activeTab: 'collect',
  settingsOpen: false,
  completionDialogOpen: false,
  previewOverlayOpen: false,
  previewMode: 'overview',
  previewSorting: [],
  previewGlobalFilter: '',
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
  openPreviewOverlay: (sessionId, mode) =>
    set((s) => ({
      previewOverlayOpen: true,
      previewMode: mode ?? s.previewMode,
      completionDialogOpen: false,
      selectedSessionId:
        sessionId !== undefined ? sessionId : s.selectedSessionId,
    })),
  closePreviewOverlay: () => set({ previewOverlayOpen: false }),
  setPreviewMode: (previewMode) => set({ previewMode }),
  setPreviewSorting: (previewSorting) => set({ previewSorting }),
  setPreviewGlobalFilter: (previewGlobalFilter) => set({ previewGlobalFilter }),
  openExportModal: (sessionId) =>
    set((s) => ({
      exportModalOpen: true,
      selectedSessionId:
        sessionId !== undefined ? sessionId : s.selectedSessionId,
    })),
  closeExportModal: () => set({ exportModalOpen: false }),
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
}));
