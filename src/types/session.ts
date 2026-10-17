export type CollectionStatus =
  | 'idle'
  | 'collecting'
  | 'paused'
  | 'completed'
  | 'error'
  | 'interrupted';

export type CollectionMode = 'manual' | 'automatic';

export interface SessionState {
  id: string;
  tabId: number;
  url: string;
  status: CollectionStatus;
  mode: CollectionMode;
  targetCount: number;
  collectedCount: number;
  startedAt: string;
  updatedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface CollectionHistory {
  id?: number;
  sessionKey: string;
  url: string;
  mode: CollectionMode;
  targetCount: number;
  collectedCount: number;
  startedAt: string;
  completedAt: string;
  status: CollectionStatus;
}