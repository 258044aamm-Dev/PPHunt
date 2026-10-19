import { getHistoryBySessionKey } from '../db/history';
import {
  readOneClickCollection,
  writeOneClickCollection,
} from '../db/one-click-state';

/**
 * SAD-286 (plan 5.2): the panel's view of where the next one-click save lands.
 *
 * Kept out of the React layer so the behaviour is testable without a renderer:
 * the hook is a thin subscription around these two functions.
 */

export interface CurrentCollection {
  sessionKey: string;
  name: string;
}

export async function readCurrentCollection(): Promise<CurrentCollection | null> {
  const pointer = await readOneClickCollection();
  if (!pointer) return null;

  // A pointer whose collection was deleted is not "current": nothing would
  // receive the next save, and the badge must disappear with the row.
  const row = await getHistoryBySessionKey(pointer.sessionKey);
  if (!row) return null;

  return { sessionKey: pointer.sessionKey, name: pointer.name };
}

/** Points new saves at an existing collection ("Make current"). */
export async function makeCollectionCurrent(
  sessionKey: string,
  name: string,
  now: Date = new Date(),
): Promise<void> {
  await writeOneClickCollection({
    sessionKey,
    name,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}
