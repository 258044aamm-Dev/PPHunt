import { getProductCountBySession } from './products';
import { addHistoryEntry } from './history';
import { db } from './database';
import type { HistoryEntry } from '../types';

/**
 * SAD-277: one-click collections are *history rows only*.
 *
 * They deliberately never write a `sessions` row: `sessions` is the full-page
 * recovery mechanism, and `getActiveSession()` / `reconcileInterruptedSessions()` /
 * `pruneOldSessions()` would adopt, interrupt or delete a curated collection
 * (plan 6.6). Everything the UI needs is already keyed by `sessionKey`.
 */

export const ONE_CLICK_SESSION_PREFIX = 'oc_';
export const ONE_CLICK_COLLECTION_ORIGIN = 'one-click' as const;
export const COLLECTION_LABEL_MAX_LENGTH = 80;

/**
 * `oc_<epochMs>`, with a numeric suffix in the (unlikely) case two collections are
 * created inside the same millisecond. Non-numeric prefix on purpose: nothing can
 * mistake a collection key for a `tabId_sessionStart` key.
 */
export async function allocateOneClickSessionKey(
  nowMs: number = Date.now(),
): Promise<string> {
  const base = `${ONE_CLICK_SESSION_PREFIX}${nowMs}`;
  let candidate = base;
  let attempt = 1;

  while (await db.history.where('sessionKey').equals(candidate).first()) {
    attempt += 1;
    candidate = `${base}_${attempt}`;
  }

  return candidate;
}

/** Display label from a product title, or a dated fallback when there is none. */
export function deriveCollectionLabel(
  product: { title?: string | null; asin?: string | null } = {},
  now: Date = new Date(),
): string {
  const raw = (product.title ?? '').replace(/\s+/g, ' ').trim();

  if (!raw) {
    return product.asin
      ? `Saved ${product.asin}`
      : `Saved ${now.toISOString().slice(0, 10)}`;
  }

  if (raw.length <= COLLECTION_LABEL_MAX_LENGTH) return raw;
  return `${raw.slice(0, COLLECTION_LABEL_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Labels are display-only (the `sessionKey` is the identity), so duplicates are
 * disambiguated with ` (2)`, ` (3)`, ... rather than rejected.
 */
export async function pickUniqueCollectionLabel(base: string): Promise<string> {
  const label = base.trim() || 'Saved';
  const rows = await db.history.toArray();
  const taken = new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  if (!taken.has(label)) return label;

  let suffix = 2;
  while (taken.has(`${label} (${suffix})`)) suffix += 1;
  return `${label} (${suffix})`;
}

export interface CreateOneClickCollectionInput {
  pageUrl: string;
  product?: { title?: string | null; asin?: string | null };
  label?: string;
  now?: Date;
}

export interface CreateOneClickCollectionResult {
  sessionKey: string;
  label: string;
  historyId: number;
}

/**
 * Creates the history row for a new one-click collection. No `sessions` row, no
 * `targetCount` promise: `targetCount: 0` marks a target-less collection (plan 7.3).
 */
export async function createOneClickCollection(
  input: CreateOneClickCollectionInput,
): Promise<CreateOneClickCollectionResult> {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const sessionKey = await allocateOneClickSessionKey(now.getTime());
  const label = await pickUniqueCollectionLabel(
    input.label ?? deriveCollectionLabel(input.product ?? {}, now),
  );

  const entry: Omit<HistoryEntry, 'id'> = {
    sessionKey,
    url: input.pageUrl,
    mode: 'manual',
    targetCount: 0,
    collectedCount: 0,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    status: 'completed',
    name: label,
    origin: ONE_CLICK_COLLECTION_ORIGIN,
  };

  const historyId = await addHistoryEntry(entry);
  return { sessionKey, label, historyId };
}

/**
 * Re-reads the true product count from `products` and writes it back, so a
 * collection's count never depends on an in-memory counter that a suspended
 * service worker would have lost.
 */
export async function refreshCollectionCounts(
  sessionKey: string,
  now: Date = new Date(),
): Promise<number> {
  const count = await getProductCountBySession(sessionKey);
  const timestamp = now.toISOString();

  await db.history
    .where('sessionKey')
    .equals(sessionKey)
    .modify({ collectedCount: count, completedAt: timestamp, updatedAt: timestamp });

  return count;
}
