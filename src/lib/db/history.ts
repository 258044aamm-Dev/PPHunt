import { db } from './database';
import { deleteSession } from './sessions';
import type { CollectionHistory } from '@/types/session';

/**
 * Adds or updates a collection history record keyed by `sessionKey`.
 * Prevents duplicate entries when both UI Stop and background completion report the same session.
 */
export async function addHistory(
  entry: Omit<CollectionHistory, 'id'>
): Promise<number> {
  if (entry.sessionKey) {
    const existing = await db.history
      .where('sessionKey')
      .equals(entry.sessionKey)
      .first();
    if (existing?.id != null) {
      await db.history.update(existing.id, {
        ...entry,
        collectedCount: Math.max(existing.collectedCount, entry.collectedCount),
      });
      return existing.id;
    }
  }
  // Dexie keys are IndexableType; auto-increment stores always yield numbers.
  return Number(await db.history.add(entry as CollectionHistory));
}

/**
 * Deletes a history entry by ID and removes all associated products
 * belonging to that extraction session (`sessionKey`) from `db.products`,
 * plus the session row itself.
 * Step 4.5 (SAD-176, M-9): one transaction — an interruption can no longer
 * orphan products, and no stale session row is left behind for
 * useSessionRecovery to surface.
 */
export async function deleteHistory(id: number): Promise<void> {
  await db.transaction(
    'rw',
    [db.history, db.products, db.sessions],
    async () => {
      const entry = await db.history.get(id);
      await db.history.delete(id);
      if (entry?.sessionKey) {
        await db.products.where('sessionKey').equals(entry.sessionKey).delete();
        await deleteSession(entry.sessionKey);
      }
    }
  );
}

/**
 * Clears all collection history records, the products of the sessions those
 * records belong to, and the matching session rows — atomically.
 * Step 4.5 (SAD-176, M-9): the product delete is SCOPED to sessionKeys that
 * actually have a history row. Products of a session with no history row
 * (e.g. an in-flight or interrupted run that never completed) deliberately
 * SURVIVE — destroying them was the M-9 bug. A true "delete everything"
 * would need its own explicitly-worded action.
 */
export async function clearAllHistory(): Promise<void> {
  await db.transaction(
    'rw',
    [db.history, db.products, db.sessions],
    async () => {
      const keys = (await db.history.toArray())
        .map((h) => h.sessionKey)
        .filter(Boolean);
      await db.history.clear();
      for (const k of keys) {
        await db.products.where('sessionKey').equals(k).delete();
        await deleteSession(k);
      }
    }
  );
}
