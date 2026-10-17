import Dexie, { type Table } from 'dexie';
import type {
  AppSettings,
  HistoryEntry,
  Product,
  SessionState,
} from '../types';

/**
 * Clean-slate Dexie IndexedDB database (`PPHuntDB`) for the Amazon engine.
 * Completely isolated from `PPHuntTemuDB`.
 */
export class PPHuntDB extends Dexie {
  products!: Table<Product, number>;
  sessions!: Table<SessionState, string>;
  history!: Table<HistoryEntry, number>;
  settings!: Table<AppSettings, string>;

  constructor(name = 'PPHuntDB') {
    super(name);

    this.version(1).stores({
      products: '++id, asin, sessionKey, collectedAt, [sessionKey+asin]',
      sessions: 'id, tabId, status, startedAt, updatedAt',
      history: '++id, sessionKey, startedAt, completedAt, status',
      settings: 'id',
    });
  }
}

export const db = new PPHuntDB();
