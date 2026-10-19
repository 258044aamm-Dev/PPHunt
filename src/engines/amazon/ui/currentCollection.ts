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
  return pointer ? { sessionKey: pointer.sessionKey, name: pointer.name } : null;
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
