/**
 * SAD-281 (plan 9 / 7.3): the pointer that says where one-click saves land.
 *
 * Deliberately separate from `pphunt.activeSession`: a full-page run must never
 * adopt a one-click save, and a one-click collection has no `sessions` row at
 * all (see the collection lifecycle tests). Stored in `storage.local` (not
 * `session`) because the choice has to survive a browser restart, and validated
 * on read because storage is user-writable.
 */

export const ONE_CLICK_COLLECTION_STORAGE_KEY = 'pphunt.oneClickCollection';

export interface OneClickCollectionPointer {
  sessionKey: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

interface LocalStorageAreaLike {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

function getLocalStorageArea(): LocalStorageAreaLike | null {
  try {
    const g = globalThis as unknown as {
      browser?: { storage?: { local?: LocalStorageAreaLike } };
      chrome?: { storage?: { local?: LocalStorageAreaLike } };
    };
    const area = g.browser?.storage?.local ?? g.chrome?.storage?.local;
    if (
      area &&
      typeof area.get === 'function' &&
      typeof area.set === 'function' &&
      typeof area.remove === 'function'
    ) {
      return area;
    }
  } catch {
    // Ignore restricted global access
  }
  return null;
}

function isPointer(value: unknown): value is OneClickCollectionPointer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionKey === 'string' &&
    candidate.sessionKey.length > 0 &&
    typeof candidate.label === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

/** Reads the pointer, or null when it is absent, malformed or unreadable. */
export async function readOneClickCollection(): Promise<OneClickCollectionPointer | null> {
  const area = getLocalStorageArea();
  if (!area) return null;

  try {
    const stored = await area.get(ONE_CLICK_COLLECTION_STORAGE_KEY);
    const value = stored?.[ONE_CLICK_COLLECTION_STORAGE_KEY];
    return isPointer(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeOneClickCollection(
  pointer: OneClickCollectionPointer,
): Promise<void> {
  const area = getLocalStorageArea();
  if (!area) return;

  try {
    await area.set({ [ONE_CLICK_COLLECTION_STORAGE_KEY]: pointer });
  } catch {
    // A lost pointer is survivable: the next save creates a new collection.
  }
}

export async function clearOneClickCollection(): Promise<void> {
  const area = getLocalStorageArea();
  if (!area) return;

  try {
    await area.remove(ONE_CLICK_COLLECTION_STORAGE_KEY);
  } catch {
    // Ignore
  }
}
