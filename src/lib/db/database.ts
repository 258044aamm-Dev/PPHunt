import Dexie, { type EntityTable } from 'dexie';
import type { Product } from '@/types/product';
import type { SessionState, CollectionHistory } from '@/types/session';
import type { AppSettings } from '@/types/settings';

export const db = new Dexie('PPHuntDB') as Dexie & {
  products: EntityTable<Product, 'id'>;
  sessions: EntityTable<SessionState, 'id'>;
  settings: EntityTable<AppSettings, 'id'>;
  history: EntityTable<CollectionHistory, 'id'>;
};

db.version(1).stores({
  products: '++id, asin, url, sessionKey, collectedAt, [sessionKey+asin]',
  sessions: 'id, tabId, status, startedAt',
  settings: 'id',
  history: '++id, sessionKey, startedAt',
});

// L-3 (SAD-151): the [sessionKey+asin] compound index had zero queries
// (session scoping goes through the plain `sessionKey` index everywhere) —
// an unused index only costs write throughput and storage. Version 2 drops
// it; version 1 stays so existing installs upgrade in place.
db.version(2).stores({
  products: '++id, asin, url, sessionKey, collectedAt',
});