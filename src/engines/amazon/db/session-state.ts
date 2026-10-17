import type { CollectionMode } from '../types';

export const ACTIVE_SESSION_STORAGE_KEY = 'pphunt.activeSession';

export interface ActiveSessionPointer {
  tabId: number;
  sessionKey: string;
  mode: CollectionMode;
  targetCount: number;
  startedAt: string;
  url: string;
  lastCollectedCount?: number;
}

interface SessionStorageAreaLike {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

function getSessionStorageArea(): SessionStorageAreaLike | null {
  try {
    const g = globalThis as unknown as {
      browser?: { storage?: { session?: SessionStorageAreaLike } };
      chrome?: { storage?: { session?: SessionStorageAreaLike } };
    };
    const area = g.browser?.storage?.session ?? g.chrome?.storage?.session;
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

function isValidActiveSessionPointer(
  candidate: unknown,
): candidate is ActiveSessionPointer {
  if (!candidate || typeof candidate !== 'object') return false;
  const obj = candidate as Record<string, unknown>;
  return (
    typeof obj.tabId === 'number' &&
    Number.isFinite(obj.tabId) &&
    typeof obj.sessionKey === 'string' &&
    obj.sessionKey.length > 0 &&
    (obj.mode === 'manual' || obj.mode === 'automatic') &&
    typeof obj.targetCount === 'number' &&
    Number.isFinite(obj.targetCount) &&
    typeof obj.startedAt === 'string' &&
    obj.startedAt.length > 0 &&
    typeof obj.url === 'string'
  );
}

export function isSessionStorageAvailable(): boolean {
  return getSessionStorageArea() !== null;
}

/**
 * Reads the active collection session pointer from `browser.storage.session`.
 * Degrades gracefully to `null` when `storage.session` is unavailable or holds malformed data.
 */
export async function readActiveSession(): Promise<ActiveSessionPointer | null> {
  const area = getSessionStorageArea();
  if (!area) return null;

  try {
    const record = await area.get(ACTIVE_SESSION_STORAGE_KEY);
    const raw = record?.[ACTIVE_SESSION_STORAGE_KEY];
    if (!isValidActiveSessionPointer(raw)) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Persists the active collection session pointer in `browser.storage.session`
 * so MV3 service worker restarts retain the original `sessionKey`, `startedAt`, `mode`, and `targetCount`.
 */
export async function writeActiveSession(
  pointer: ActiveSessionPointer,
): Promise<void> {
  const area = getSessionStorageArea();
  if (!area) return;

  try {
    await area.set({ [ACTIVE_SESSION_STORAGE_KEY]: pointer });
  } catch {
    // Degrade gracefully when storage.session fails
  }
}

/**
 * Clears the active collection session pointer from `browser.storage.session`.
 */
export async function clearActiveSession(): Promise<void> {
  const area = getSessionStorageArea();
  if (!area) return;

  try {
    await area.remove(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // Degrade gracefully
  }
}
