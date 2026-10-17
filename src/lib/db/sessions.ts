import { db } from './database';
import type { SessionState, CollectionStatus } from '@/types/session';
import { DEFAULT_TARGET_COUNT, clampTargetCount } from '@/constants/defaults';

/**
 * Reads the leading numeric tab segment from a session key.
 * Tolerates both the canonical `${tabId}_${ts}` format (createSession) and the
 * legacy background-minted `session_${tabId}_${ts}` form so in-flight sessions
 * survive the upgrade (Step 4.1, SAD-172).
 */
function parseTabIdFromSessionKey(sessionKey: string): number {
  const match = /^(?:session_)?(\d+)_/.exec(sessionKey);
  return match ? parseInt(match[1]!, 10) : 0;
}

export async function createSession(
  tabId: number,
  url: string,
  mode: 'manual' | 'automatic' = 'manual',
  targetCount: number = DEFAULT_TARGET_COUNT,
  status: CollectionStatus = 'collecting'
): Promise<string> {
  const now = new Date().toISOString();
  const sessionKey = `${tabId}_${Date.now()}`;
  await db.sessions.put({
    id: sessionKey,
    tabId,
    url,
    status,
    mode,
    targetCount: clampTargetCount(targetCount),
    collectedCount: 0,
    startedAt: now,
    updatedAt: now,
  });
  return sessionKey;
}

/**
 * Step 4.1 (SAD-172) / 4.2 (SAD-173): create the session row for `sessionKey`
 * IF it does not exist, so later status updates and the History read-back land
 * on a real row (real url / startedAt / mode) instead of fabricated fallbacks.
 * Takes the caller's exact key — the background's minted key and the pointer's
 * startedAt are authoritative; an existing row is never clobbered.
 */
export async function ensureSession(
  sessionKey: string,
  tabId: number,
  url: string,
  mode: 'manual' | 'automatic' = 'manual',
  targetCount: number = DEFAULT_TARGET_COUNT,
  startedAt?: string
): Promise<string> {
  const existing = await db.sessions.get(sessionKey);
  if (existing) return sessionKey;
  const now = new Date().toISOString();
  await db.sessions.put({
    id: sessionKey,
    tabId,
    url,
    status: 'collecting',
    mode,
    targetCount: clampTargetCount(targetCount),
    collectedCount: 0,
    startedAt: startedAt ?? now,
    updatedAt: now,
  });
  return sessionKey;
}

/**
 * Step 4.1 (SAD-172): transactional UPSERT. The previous `db.sessions.update()`
 * silently resolved to 0 when the row was missing (every background-minted
 * key), dropping the status change. Now a missing row is created with sensible
 * defaults — and an existing row's original `startedAt` is always preserved.
 */
export async function updateSessionStatus(
  sessionKey: string,
  status: CollectionStatus,
  counts?: { collected: number; target?: number },
  errorMessage?: string
): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction('rw', db.sessions, async () => {
    const existing = await db.sessions.get(sessionKey);
    const base: SessionState = existing ?? {
      id: sessionKey,
      tabId: parseTabIdFromSessionKey(sessionKey),
      url: '',
      status,
      mode: 'manual',
      targetCount: DEFAULT_TARGET_COUNT,
      collectedCount: 0,
      startedAt: now,
    };
    const next: SessionState = { ...base, status, updatedAt: now };
    if (counts) {
      next.collectedCount = counts.collected;
      if (typeof counts.target === 'number' && counts.target > 0) {
        next.targetCount = counts.target;
      }
    }
    if (status === 'completed' || status === 'interrupted') {
      next.completedAt = now;
    }
    if (errorMessage !== undefined) {
      next.errorMessage = errorMessage;
    }
    await db.sessions.put(next);
  });
}

/**
 * Step 4.1 (SAD-172): pick the most RECENT active session, not the lowest
 * primary key. Keys are `${tabId}_${ts}` strings, so `first()` ordered
 * lexicographically — `"10_..." < "9_..."` — and could restore a years-old
 * session. Sorting in JS after toArray() keeps this index-free; the row count
 * is small.
 */
export async function getActiveSession(): Promise<SessionState | undefined> {
  const rows = await db.sessions
    .where('status')
    .anyOf(['collecting', 'paused'])
    .toArray();
  return rows.sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
  )[0];
}

/**
 * L-5 (SAD-197): mark every 'collecting' session as 'interrupted'.
 *
 * Called at browser startup / fresh worker session, when nothing can
 * legitimately be collecting: Chrome killed the MV3 worker mid-run (H-8) or
 * the browser restarted, so any leftover 'collecting' row belongs to a dead
 * run and — left alone — would be indistinguishable from a genuinely running
 * session forever. Existing rows are NOT retroactively migrated beyond this;
 * 'paused' / 'completed' / 'error' rows are untouched. Returns the number of
 * rows reconciled.
 */
export async function reconcileInterruptedSessions(): Promise<number> {
  const now = new Date().toISOString();
  return db.sessions
    .where('status')
    .equals('collecting')
    .modify((s) => {
      s.status = 'interrupted';
      s.updatedAt = now;
      s.completedAt = now;
    });
}

export async function getSession(
  sessionKey: string
): Promise<SessionState | undefined> {
  return db.sessions.get(sessionKey);
}

export async function deleteSession(sessionKey: string): Promise<void> {
  await db.sessions.delete(sessionKey);
}

/**
 * Step 4.3 (SAD-174): stop the sessions table growing forever. Removes
 * terminal sessions (`completed` / `interrupted` / `error`) whose last update
 * is older than `maxAgeMs`, plus their orphaned products, in one transaction.
 * Active sessions (`collecting` / `paused`) are never touched.
 * Returns the number of sessions removed.
 */
export async function pruneOldSessions(
  maxAgeMs = 30 * 24 * 60 * 60 * 1000
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  return db.transaction(
    'rw',
    [db.sessions, db.products],
    async () => {
      const stale = await db.sessions
        .filter(
          (s) =>
            ['completed', 'interrupted', 'error'].includes(s.status) &&
            Date.parse(s.updatedAt ?? s.startedAt) < cutoff
        )
        .toArray();
      for (const s of stale) {
        await db.products.where('sessionKey').equals(s.id).delete();
        await db.sessions.delete(s.id);
      }
      return stale.length;
    }
  );
}
