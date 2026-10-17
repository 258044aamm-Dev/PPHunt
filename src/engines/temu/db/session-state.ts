import { TEMU_ACTIVE_SESSION_KEY } from '../constants/defaults';
import type { TemuCollectionMode, TemuPageType } from '../types';

export interface ActiveTemuSessionPointer {
  tabId: number | null;
  sessionId: string | null;
  mode: TemuCollectionMode;
  targetCount: number;
  startedAt: string | null;
  url: string | null;
  pageType: TemuPageType;
  searchQuery: string | null;
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

function isTemuPointer(value: unknown): value is ActiveTemuSessionPointer {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.sessionId === null || typeof v.sessionId === 'string') &&
    (v.tabId === null || typeof v.tabId === 'number') &&
    typeof v.lastCollectedCount === 'number'
  );
}

export function isTemuSessionStorageAvailable(): boolean {
  return sessionArea() !== null;
}

export async function readActiveTemuSession(): Promise<ActiveTemuSessionPointer | null> {
  const area = sessionArea();
  if (!area) return null;
  try {
    const stored = await area.get(TEMU_ACTIVE_SESSION_KEY);
    const value = stored[TEMU_ACTIVE_SESSION_KEY];
    return isTemuPointer(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeActiveTemuSession(
  pointer: ActiveTemuSessionPointer
): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.set({ [TEMU_ACTIVE_SESSION_KEY]: pointer });
  } catch {
    // Best-effort; IndexedDB fallback covers restart
  }
}

export async function clearActiveTemuSession(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.remove(TEMU_ACTIVE_SESSION_KEY);
  } catch {
    // Best-effort
  }
}
