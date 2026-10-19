import { clampTargetCount } from '../constants/defaults';
import type { CollectionMode, SessionState, SessionStatus } from '../types';
import { db } from './database';

const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Extracts numeric `tabId` from either `${tabId}_${ts}` or legacy `session_${tabId}_${ts}` keys.
 */
export function parseTabIdFromSessionKey(sessionKey: string): number {
  const directMatch = /^(\d+)_/.exec(sessionKey);
  if (directMatch?.[1]) {
    const parsed = Number.parseInt(directMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const legacyMatch = /^session_(\d+)_/.exec(sessionKey);
  if (legacyMatch?.[1]) {
    const parsed = Number.parseInt(legacyMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Creates a new collection session row in `db.sessions` and returns its `sessionKey`.
 */
export async function createSession(
  tabId: number,
  url: string,
  mode: CollectionMode = 'manual',
  targetCount = 50,
): Promise<string> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const id = `${tabId}_${nowMs}`;
  const clampedTarget = clampTargetCount(targetCount);

  const row: SessionState = {
    id,
    tabId,
    url,
    status: 'collecting',
    mode,
    targetCount: clampedTarget,
    collectedCount: 0,
    startedAt: nowIso,
    updatedAt: nowIso,
  };

  await db.sessions.put(row);
  return id;
}

/**
 * Ensures a session row exists for `sessionKey` without clobbering an existing row.
 */
export async function ensureSession(
  sessionKey: string,
  tabId: number,
  url: string,
  mode: CollectionMode = 'manual',
  targetCount = 50,
  startedAt?: string,
): Promise<string> {
  const existing = await db.sessions.get(sessionKey);
  if (existing) {
    return sessionKey;
  }

  const nowIso = new Date().toISOString();
  const row: SessionState = {
    id: sessionKey,
    tabId,
    url,
    status: 'collecting',
    mode,
    targetCount: clampTargetCount(targetCount),
    collectedCount: 0,
    startedAt: startedAt || nowIso,
    updatedAt: nowIso,
  };

  await db.sessions.put(row);
  return sessionKey;
}

export async function getSession(
  sessionKey: string,
): Promise<SessionState | undefined> {
  return db.sessions.get(sessionKey);
}

/**
 * Selects the chronologically most recent active (`collecting` or `paused`) session.
 * Never relies on lexicographical primary-key ordering (`'10_...'` vs `'9_...'`).
 */
export async function getActiveSession(): Promise<SessionState | undefined> {
  const candidates = await db.sessions
    .where('status')
    .anyOf(['collecting', 'paused'])
    .toArray();

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const timeA = Date.parse(a.startedAt) || 0;
    const timeB = Date.parse(b.startedAt) || 0;
    return timeB - timeA;
  });

  return candidates[0];
}

/**
 * Upserts session status, progress counts, and timestamps in `db.sessions`.
 * Preserves original `startedAt` when the row already exists and synthesizes a valid row
 * when `sessionKey` was not yet persisted.
 */
export async function updateSessionStatus(
  sessionKey: string,
  status: SessionStatus,
  progress?: { collected?: number; target?: number },
  errorMessage?: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const existing = await db.sessions.get(sessionKey);
  const isTerminal =
    status === 'completed' ||
    status === 'interrupted' ||
    status === 'error' ||
    status === 'idle';

  if (existing) {
    const nextRow: SessionState = {
      ...existing,
      status,
      collectedCount:
        progress?.collected !== undefined
          ? progress.collected
          : existing.collectedCount,
      targetCount:
        progress?.target !== undefined
          ? clampTargetCount(progress.target)
          : existing.targetCount,
      updatedAt: nowIso,
      ...(isTerminal
        ? { completedAt: existing.completedAt ?? nowIso }
        : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
    await db.sessions.put(nextRow);
    return;
  }

  const createdRow: SessionState = {
    id: sessionKey,
    tabId: parseTabIdFromSessionKey(sessionKey),
    url: '',
    status,
    mode: 'manual',
    targetCount:
      progress?.target !== undefined
        ? clampTargetCount(progress.target)
        : 50,
    collectedCount: progress?.collected ?? 0,
    startedAt: nowIso,
    updatedAt: nowIso,
    ...(isTerminal ? { completedAt: nowIso } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };

  await db.sessions.put(createdRow);
}

/**
 * Startup reconciliation: flips stale `collecting` sessions to `interrupted`
 * while leaving `paused`, `completed`, and other statuses untouched.
 */
export async function reconcileInterruptedSessions(): Promise<number> {
  const staleCollecting = await db.sessions
    .where('status')
    .equals('collecting')
    .toArray();

  if (staleCollecting.length === 0) return 0;

  const nowIso = new Date().toISOString();
  for (const row of staleCollecting) {
    await db.sessions.put({
      ...row,
      status: 'interrupted',
      updatedAt: nowIso,
      completedAt: row.completedAt ?? nowIso,
    });
  }

  return staleCollecting.length;
}

/**
 * Prunes terminal sessions older than `maxAgeMs` (default 30 days) along with their products.
 * Never removes active (`collecting` or `paused`) sessions.
 */
export async function pruneOldSessions(
  maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS,
): Promise<number> {
  const cutoffMs = Date.now() - maxAgeMs;
  const allSessions = await db.sessions.toArray();

  const staleIds: string[] = [];
  for (const s of allSessions) {
    if (s.status === 'collecting' || s.status === 'paused') {
      continue;
    }
    const refTime =
      Date.parse(s.updatedAt ?? s.completedAt ?? s.startedAt) || 0;
    if (refTime > 0 && refTime < cutoffMs) {
      staleIds.push(s.id);
    }
  }

  if (staleIds.length === 0) return 0;

  await db.transaction(
    'rw',
    [db.sessions, db.products, db.snapshots],
    async () => {
      for (const sessionKey of staleIds) {
        await db.products.where('sessionKey').equals(sessionKey).delete();
        await db.sessions.delete(sessionKey);
        await db.snapshots.where('sessionKey').equals(sessionKey).delete();
      }
    },
  );

  return staleIds.length;
}

export async function deleteSession(sessionKey: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.sessions, db.products, db.snapshots],
    async () => {
      await db.products.where('sessionKey').equals(sessionKey).delete();
      await db.sessions.delete(sessionKey);
      await db.snapshots.where('sessionKey').equals(sessionKey).delete();
    },
  );
}
