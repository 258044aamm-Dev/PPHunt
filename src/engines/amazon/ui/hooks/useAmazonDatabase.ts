import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/database';
import type { AmazonProduct } from '../../types/product';
import type { HistoryEntry } from '../../types';

/**
 * Live-queries products for an optional `sessionKey` (or all products when omitted).
 */
export function useAmazonProducts(sessionKey?: string | null): AmazonProduct[] {
  return (
    useLiveQuery(
      () =>
        sessionKey
          ? db.products.where('sessionKey').equals(sessionKey).toArray()
          : db.products.toArray(),
      [sessionKey],
    ) ?? []
  );
}

/**
 * Live-queries extraction history entries in reverse chronological order.
 */
export function useAmazonHistory(): HistoryEntry[] {
  return (
    useLiveQuery(
      () => db.history.orderBy('completedAt').reverse().toArray(),
      [],
    ) ?? []
  );
}
