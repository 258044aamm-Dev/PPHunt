import type { HistoryEntry } from '../types';
import { db } from './database';

/**
 * Adds or updates a HistoryEntry for `entry.sessionKey` so duplicate completion
 * events never create duplicate rows for the same session.
 */
export async function addHistoryEntry(
  entry: Omit<HistoryEntry, 'id'>,
): Promise<number> {
  const existing = await db.history
    .where('sessionKey')
    .equals(entry.sessionKey)
    .first();

  if (existing?.id !== undefined) {
    await db.history.update(existing.id, {
      ...entry,
      startedAt: existing.startedAt || entry.startedAt,
    });
    return existing.id;
  }

  return (await db.history.add(entry as HistoryEntry)) as number;
}

export const addHistory = addHistoryEntry;

export async function getHistoryEntries(): Promise<HistoryEntry[]> {
  const all = await db.history.toArray();
  return all.sort((a, b) => {
    const timeA = Date.parse(a.startedAt || a.completedAt) || 0;
    const timeB = Date.parse(b.startedAt || b.completedAt) || 0;
    return timeB - timeA;
  });
}

export const getAllHistory = getHistoryEntries;

export async function getHistoryBySessionKey(
  sessionKey: string,
): Promise<HistoryEntry | undefined> {
  return db.history.where('sessionKey').equals(sessionKey).first();
}

/**
 * Atomically deletes a single history entry, its products, and its session row.
 */
export async function deleteHistory(id: number): Promise<void> {
  await db.transaction(
    'rw',
    [db.history, db.products, db.sessions, db.snapshots],
    async () => {
      const entry = await db.history.get(id);
      if (!entry) return;
      await db.history.delete(id);
      if (entry.sessionKey) {
        await db.products
          .where('sessionKey')
          .equals(entry.sessionKey)
          .delete();
        // One-click collections have no sessions row; deleting a missing key is
        // a no-op, so the same cascade serves both collection kinds.
        await db.sessions.delete(entry.sessionKey);
        await db.snapshots
          .where('sessionKey')
          .equals(entry.sessionKey)
          .delete();
      }
    },
  );
}

export const deleteHistoryEntry = deleteHistory;

/**
 * Scoped & atomic "Clear All History" (M-9):
 * Deletes all history rows and ONLY the products and session rows belonging to those
 * history entries, preserving any in-flight session's products and session state.
 */
export async function clearAllHistory(): Promise<void> {
  await db.transaction(
    'rw',
    [db.history, db.products, db.sessions, db.snapshots],
    async () => {
      const historyRows = await db.history.toArray();
      const sessionKeys = Array.from(
        new Set(
          historyRows
            .map((row) => row.sessionKey)
            .filter((k): k is string => Boolean(k)),
        ),
      );

      await db.history.clear();

      for (const sessionKey of sessionKeys) {
        await db.products.where('sessionKey').equals(sessionKey).delete();
        await db.sessions.delete(sessionKey);
        await db.snapshots.where('sessionKey').equals(sessionKey).delete();
      }
    },
  );
}
