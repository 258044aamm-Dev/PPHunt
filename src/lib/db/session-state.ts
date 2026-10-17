/**
 * Step 4.2 (SAD-173) — H-8: the active-session pointer for the background
 * service worker, backed by `chrome.storage.session`.
 *
 * MV3 terminates the worker between events; module-scope variables die with
 * it. `storage.session` survives worker termination within a browser session
 * and is cleared automatically when the browser closes — exactly the lifetime
 * an in-flight collection has. IndexedDB remains the source of truth for the
 * session ROW (db/sessions.ts); this file only stores the pointer, and is
 * feature-guarded because `storage.session` is MV3-only (Firefox / older
 * Chrome fall back to the IndexedDB path in `ensureHydrated`).
 */

const KEY = 'pphunt.activeSession';

export interface ActiveSessionPointer {
  tabId: number | null;
  sessionKey: string | null;
  mode: 'manual' | 'automatic';
  targetCount: number;
  startedAt: string | null;
  url: string | null;
  lastCollectedCount: number;
}

interface StorageAreaLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

function sessionArea(): StorageAreaLike | null {
  try {
    const g = globalThis as unknown as {
      browser?: { storage?: { session?: StorageAreaLike } };
      chrome?: { storage?: { session?: StorageAreaLike } };
    };
    const area = g.browser?.storage?.session ?? g.chrome?.storage?.session;
    return typeof area?.get === 'function' ? area : null;
  } catch {
    return null;
  }
}

function isPointer(value: unknown): value is ActiveSessionPointer {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.sessionKey === null || typeof v.sessionKey === 'string') &&
    (v.tabId === null || typeof v.tabId === 'number') &&
    typeof v.lastCollectedCount === 'number'
  );
}

/**
 * True when `chrome.storage.session` exists (MV3 Chrome). False on
 * Firefox / older Chrome, where the pointer cannot survive worker restarts
 * and the IndexedDB fallback in `ensureHydrated` is the deliberate survival
 * path — callers must not treat "no pointer" as "browser restarted" there.
 */
export function isSessionStorageAvailable(): boolean {
  return sessionArea() !== null;
}

export async function readActiveSession(): Promise<ActiveSessionPointer | null> {
  const area = sessionArea();
  if (!area) return null;
  try {
    const stored = await area.get(KEY);
    const value = stored[KEY];
    return isPointer(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeActiveSession(
  pointer: ActiveSessionPointer
): Promise<void> {
  const area = sessionArea();
  if (!area) return; // graceful degradation — never block collection
  try {
    await area.set({ [KEY]: pointer });
  } catch {
    // best-effort; IndexedDB fallback still covers a restart
  }
}

export async function clearActiveSession(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.remove(KEY);
  } catch {
    // best-effort
  }
}
