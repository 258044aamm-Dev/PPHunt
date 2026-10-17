import Dexie, { type EntityTable } from 'dexie';
import { TEMU_DB_NAME } from '../constants/defaults';
import type {
  TemuCollectionSession,
  TemuProduct,
  TemuSettings,
} from '../types';

export interface TemuSettingsRow extends TemuSettings {
  id: string;
}

export interface TemuCollectionHistory {
  id?: number;
  sessionId: string;
  url: string;
  searchQuery: string | null;
  pageType: TemuCollectionSession['pageType'];
  mode: TemuCollectionSession['mode'];
  targetCount: number;
  collectedCount: number;
  startedAt: number;
  completedAt: number;
  status: TemuCollectionSession['status'];
}

export class PPHuntTemuDatabase extends Dexie {
  products!: EntityTable<TemuProduct, 'id'>;
  sessions!: EntityTable<TemuCollectionSession, 'id'>;
  settings!: EntityTable<TemuSettingsRow, 'id'>;
  history!: EntityTable<TemuCollectionHistory, 'id'>;

  constructor(name: string = TEMU_DB_NAME) {
    super(name);

    this.version(1).stores({
      products:
        '++id, goodsId, asin, sessionId, collectedAt, [sessionId+goodsId], [sessionId+asin]',
      sessions: 'id, tabId, status, startedAt',
      settings: 'id',
      history: '++id, sessionId, startedAt',
    });
  }
}

export const temuDb = new PPHuntTemuDatabase();
