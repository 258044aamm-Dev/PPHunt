import { temuDb } from './database';
import {
  DEFAULT_TEMU_SETTINGS,
  TEMU_TARGET_MAX,
  TEMU_TARGET_MIN,
} from '../constants/defaults';
import type {
  TemuCollectionMode,
  TemuCollectionSession,
  TemuCollectionStatus,
  TemuPageType,
} from '../types';

function clampTemuTargetCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_TEMU_SETTINGS.defaultTargetCount;
  return Math.max(TEMU_TARGET_MIN, Math.min(TEMU_TARGET_MAX, Math.round(count)));
}

export async function createTemuSession(
  tabId: number,
  url: string,
  mode: TemuCollectionMode = 'manual',
  targetCount: number = DEFAULT_TEMU_SETTINGS.defaultTargetCount,
  pageType: TemuPageType = 'search',
  searchQuery: string | null = null,
  status: TemuCollectionStatus = 'collecting'
): Promise<string> {
  const nowIso = new Date().toISOString();
  const sessionId = `temu_${tabId}_${Date.now()}`;
  await temuDb.sessions.add({
    sessionId,
    url,
    searchQuery,
    pageType,
    mode,
    targetCount: clampTemuTargetCount(targetCount),
    collectedCount: 0,
    status,
    startedAt: nowIso,
    completedAt: null,
  });
  return sessionId;
}

export async function ensureTemuSession(
  sessionId: string,
  url: string,
  mode: TemuCollectionMode = 'manual',
  targetCount: number = DEFAULT_TEMU_SETTINGS.defaultTargetCount,
  pageType: TemuPageType = 'search',
  searchQuery: string | null = null,
  startedAt?: string
): Promise<string> {
  const existing = await temuDb.sessions
    .where('sessionId')
    .equals(sessionId)
    .first();
  if (existing) return sessionId;
  const nowIso = new Date().toISOString();
  await temuDb.sessions.add({
    sessionId,
    url,
    searchQuery,
    pageType,
    mode,
    targetCount: clampTemuTargetCount(targetCount),
    collectedCount: 0,
    status: 'collecting',
    startedAt: startedAt ?? nowIso,
    completedAt: null,
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
  const nowIso = new Date().toISOString();
  await temuDb.transaction('rw', temuDb.sessions, async () => {
    const existing = await temuDb.sessions
      .where('sessionId')
      .equals(sessionId)
      .first();
    const base: TemuCollectionSession = existing ?? {
      sessionId,
      url: metadata?.url ?? '',
      searchQuery: metadata?.searchQuery ?? null,
      pageType: metadata?.pageType ?? 'search',
      status,
      mode: 'manual',
      targetCount: DEFAULT_TEMU_SETTINGS.defaultTargetCount,
      collectedCount: 0,
      startedAt: nowIso,
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

    if (status === 'completed' || status === 'stopped' || status === 'error') {
      next.completedAt = nowIso;
    }

    if (existing?.id != null) {
      await temuDb.sessions.put({ ...next, id: existing.id });
    } else {
      await temuDb.sessions.add(next);
    }
  });
}

export async function getActiveTemuSession(): Promise<
  TemuCollectionSession | undefined
> {
  const rows = await temuDb.sessions
    .where('status')
    .anyOf(['collecting', 'paused'])
    .toArray();
  return rows.sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
  )[0];
}

export async function reconcileInterruptedTemuSessions(): Promise<number> {
  const nowIso = new Date().toISOString();
  return temuDb.sessions
    .where('status')
    .equals('collecting')
    .modify((s) => {
      s.status = 'stopped';
      s.completedAt = nowIso;
    });
}

export async function getTemuSession(
  sessionId: string
): Promise<TemuCollectionSession | undefined> {
  return temuDb.sessions.where('sessionId').equals(sessionId).first();
}

export async function deleteTemuSession(sessionId: string): Promise<void> {
  await temuDb.sessions.where('sessionId').equals(sessionId).delete();
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
            ['completed', 'stopped', 'error'].includes(s.status) &&
            Date.parse(s.completedAt ?? s.startedAt) < cutoff
        )
        .toArray();
      for (const s of stale) {
        await temuDb.products.where('sessionId').equals(s.sessionId).delete();
        await temuDb.sessions.where('sessionId').equals(s.sessionId).delete();
      }
      return stale.length;
    }
  );
}
