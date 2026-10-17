import { temuDb } from './database';
import {
  DEFAULT_TEMU_TARGET_COUNT,
  clampTemuTargetCount,
} from '../constants/defaults';
import type {
  TemuCollectionMode,
  TemuCollectionSession,
  TemuCollectionStatus,
  TemuPageType,
} from '../types';

function parseTabIdFromSessionId(sessionId: string): number {
  const match = /^(?:temu_)?(\d+)_/.exec(sessionId);
  return match ? parseInt(match[1]!, 10) : 0;
}

export async function createTemuSession(
  tabId: number,
  url: string,
  mode: TemuCollectionMode = 'manual',
  targetCount: number = DEFAULT_TEMU_TARGET_COUNT,
  pageType: TemuPageType = 'search',
  searchQuery: string | null = null,
  status: TemuCollectionStatus = 'collecting'
): Promise<string> {
  const now = Date.now();
  const sessionId = `temu_${tabId}_${now}`;
  await temuDb.sessions.put({
    id: sessionId,
    url,
    searchQuery,
    pageType,
    mode,
    targetCount: clampTemuTargetCount(targetCount),
    collectedCount: 0,
    status,
    startedAt: now,
    completedAt: null,
    tabId,
  });
  return sessionId;
}

export async function ensureTemuSession(
  sessionId: string,
  tabId: number,
  url: string,
  mode: TemuCollectionMode = 'manual',
  targetCount: number = DEFAULT_TEMU_TARGET_COUNT,
  pageType: TemuPageType = 'search',
  searchQuery: string | null = null,
  startedAt?: number
): Promise<string> {
  const existing = await temuDb.sessions.get(sessionId);
  if (existing) return sessionId;
  const now = Date.now();
  await temuDb.sessions.put({
    id: sessionId,
    url,
    searchQuery,
    pageType,
    mode,
    targetCount: clampTemuTargetCount(targetCount),
    collectedCount: 0,
    status: 'collecting',
    startedAt: startedAt ?? now,
    completedAt: null,
    tabId,
  });
  return sessionId;
}

export async function updateTemuSessionStatus(
  sessionId: string,
  status: TemuCollectionStatus,
  counts?: { collected: number; target?: number },
  metadata?: {
    url?: string;
    pageType?: TemuPageType;
    searchQuery?: string | null;
  }
): Promise<void> {
  const now = Date.now();
  await temuDb.transaction('rw', temuDb.sessions, async () => {
    const existing = await temuDb.sessions.get(sessionId);
    const base: TemuCollectionSession = existing ?? {
      id: sessionId,
      tabId: parseTabIdFromSessionId(sessionId),
      url: metadata?.url ?? '',
      searchQuery: metadata?.searchQuery ?? null,
      pageType: metadata?.pageType ?? 'search',
      status,
      mode: 'manual',
      targetCount: DEFAULT_TEMU_TARGET_COUNT,
      collectedCount: 0,
      startedAt: now,
      completedAt: null,
    };

    const next: TemuCollectionSession = {
      ...base,
      status,
      ...(metadata?.url ? { url: metadata.url } : {}),
      ...(metadata?.pageType ? { pageType: metadata.pageType } : {}),
      ...(metadata?.searchQuery !== undefined
        ? { searchQuery: metadata.searchQuery }
        : {}),
    };

    if (counts) {
      next.collectedCount = counts.collected;
      if (typeof counts.target === 'number' && counts.target > 0) {
        next.targetCount = counts.target;
      }
    }

    if (
      status === 'completed' ||
      status === 'interrupted' ||
      status === 'error'
    ) {
      next.completedAt = now;
    }

    await temuDb.sessions.put(next);
  });
}

export async function getActiveTemuSession(): Promise<
  TemuCollectionSession | undefined
> {
  const rows = await temuDb.sessions
    .where('status')
    .anyOf(['collecting', 'paused'])
    .toArray();
  return rows.sort((a, b) => b.startedAt - a.startedAt)[0];
}

export async function reconcileInterruptedTemuSessions(): Promise<number> {
  const now = Date.now();
  return temuDb.sessions
    .where('status')
    .equals('collecting')
    .modify((s) => {
      s.status = 'interrupted';
      s.completedAt = now;
    });
}

export async function getTemuSession(
  sessionId: string
): Promise<TemuCollectionSession | undefined> {
  return temuDb.sessions.get(sessionId);
}

export async function deleteTemuSession(sessionId: string): Promise<void> {
  await temuDb.sessions.delete(sessionId);
}

export async function pruneOldTemuSessions(
  maxAgeMs = 30 * 24 * 60 * 60 * 1000
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  return temuDb.transaction(
    'rw',
    [temuDb.sessions, temuDb.products],
    async () => {
      const stale = await temuDb.sessions
        .filter(
          (s) =>
            ['completed', 'interrupted', 'error'].includes(s.status) &&
            (s.completedAt ?? s.startedAt) < cutoff
        )
        .toArray();
      for (const s of stale) {
        await temuDb.products.where('sessionId').equals(s.id).delete();
        await temuDb.sessions.delete(s.id);
      }
      return stale.length;
    }
  );
}
