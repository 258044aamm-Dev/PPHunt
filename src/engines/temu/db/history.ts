import { temuDb, type TemuCollectionHistory } from './database';
import { deleteTemuSession } from './sessions';
import { TEMU_MAX_HISTORY_SESSIONS } from '../constants/defaults';

/**
 * Adds or updates a Temu collection history entry keyed by `sessionId`,
 * enforcing the 50-session history cap and cascading product deletion for pruned entries.
 */
export async function addTemuHistory(
  entry: Omit<TemuCollectionHistory, 'id'>
): Promise<number> {
  return temuDb.transaction(
    'rw',
    [temuDb.history, temuDb.products, temuDb.sessions],
    async () => {
      if (entry.sessionId) {
        const existing = await temuDb.history
          .where('sessionId')
          .equals(entry.sessionId)
          .first();
        if (existing?.id != null) {
          await temuDb.history.update(existing.id, {
            ...entry,
            collectedCount: Math.max(
              existing.collectedCount,
              entry.collectedCount
            ),
          });
          return existing.id;
        }
      }

      const newId = Number(
        await temuDb.history.add(entry as TemuCollectionHistory)
      );

      // Enforce 50-session history cap (delete oldest beyond TEMU_MAX_HISTORY_SESSIONS)
      const allEntries = await temuDb.history
        .orderBy('startedAt')
        .reverse()
        .toArray();
      if (allEntries.length > TEMU_MAX_HISTORY_SESSIONS) {
        const overflow = allEntries.slice(TEMU_MAX_HISTORY_SESSIONS);
        for (const old of overflow) {
          if (old.id != null) {
            await temuDb.history.delete(old.id);
          }
          if (old.sessionId) {
            await temuDb.products
              .where('sessionId')
              .equals(old.sessionId)
              .delete();
            await deleteTemuSession(old.sessionId);
          }
        }
      }

      return newId;
    }
  );
}

export async function getTemuHistory(): Promise<TemuCollectionHistory[]> {
  return temuDb.history.orderBy('startedAt').reverse().toArray();
}

export async function deleteTemuHistory(id: number): Promise<void> {
  await temuDb.transaction(
    'rw',
    [temuDb.history, temuDb.products, temuDb.sessions],
    async () => {
      const entry = await temuDb.history.get(id);
      await temuDb.history.delete(id);
      if (entry?.sessionId) {
        await temuDb.products
          .where('sessionId')
          .equals(entry.sessionId)
          .delete();
        await deleteTemuSession(entry.sessionId);
      }
    }
  );
}

export async function clearAllTemuHistory(): Promise<void> {
  await temuDb.transaction(
    'rw',
    [temuDb.history, temuDb.products, temuDb.sessions],
    async () => {
      const sessionIds = (await temuDb.history.toArray())
        .map((h) => h.sessionId)
        .filter(Boolean);
      await temuDb.history.clear();
      for (const sid of sessionIds) {
        await temuDb.products.where('sessionId').equals(sid).delete();
        await deleteTemuSession(sid);
      }
    }
  );
}
