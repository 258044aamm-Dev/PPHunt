import Dexie, { type Table } from 'dexie';
import type {
  AppSettings,
  HistoryEntry,
  Product,
  ProductSnapshot,
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
  snapshots!: Table<ProductSnapshot, number>;

  constructor(name = 'PPHuntDB') {
    super(name);

    this.version(1).stores({
      products: '++id, asin, sessionKey, collectedAt, [sessionKey+asin]',
      sessions: 'id, tabId, status, startedAt, updatedAt',
      history: '++id, sessionKey, startedAt, completedAt, status',
      settings: 'id',
    });

    // v2 (SAD-275): one row per observation, so re-saving a product records the
    // new price/rating/BSR instead of overwriting the only copy. Additive only:
    // the v1 stores are inherited untouched and no row is rewritten on upgrade.
    this.version(2).stores({
      snapshots: '++id, asin, sessionKey, capturedAt, [asin+capturedAt]',
    });
  }
}

export const db = new PPHuntDB();
