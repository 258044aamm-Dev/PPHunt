import {
  createOneClickCollection,
  deriveCollectionLabel,
  pickUniqueCollectionLabel,
} from '../db/collections';
import { getHistoryBySessionKey } from '../db/history';
import { readOneClickCollection, writeOneClickCollection } from '../db/one-click-state';
import { getSession } from '../db/sessions';
import { getSettings } from '../db/settings';
import type { QuickSaveCollectionBehavior } from '../types';

/**
 * SAD-285 (plan 7.1-7.3): where a one-click save lands.
 *
 * Three guarantees, each with a test:
 *   1. A pointer is only reused while its History row still exists.
 *   2. A pointer that resolves to a `sessions` row is discarded - that is a
 *      full-page run, and a quick save must never join or mutate one.
 *   3. Nothing here writes `db.sessions`; one-click collections are
 *      history-only, so `getActiveSession()` can never pick one up.
 */

export interface CollectionTargetInput {
  pageUrl: string;
  product: { title?: string | null; asin?: string | null };
  /** Overrides the stored setting; used by tests and by the ask dialog flow. */
  behavior?: QuickSaveCollectionBehavior;
  now?: Date;
}

export interface CollectionTarget {
  sessionKey: string;
  label: string;
  created: boolean;
  /** `ask` asks the user after the product is safely persisted (P3.3). */
  requiresChoice: boolean;
  defaultCollectionKey?: string;
}

/** True when `sessionKey` belongs to a full-page run (it has a `sessions` row). */
export async function isFullPageSession(sessionKey: string): Promise<boolean> {
  try {
    const row = await getSession(sessionKey);
    return Boolean(row);
  } catch {
    // If the table cannot be read, assume it is not ours to join.
    return true;
  }
}

async function pointerIsReusable(sessionKey: string): Promise<boolean> {
  const historyRow = await getHistoryBySessionKey(sessionKey);
  if (!historyRow) return false;
  if (await isFullPageSession(sessionKey)) return false;
  return true;
}

async function createAndPoint(
  input: CollectionTargetInput,
  now: Date,
  requiresChoice: boolean,
): Promise<CollectionTarget> {
  const created = await createOneClickCollection({
    pageUrl: input.pageUrl,
    product: input.product,
    now,
  });

  await writeOneClickCollection({
    sessionKey: created.sessionKey,
    name: created.label,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  return {
    sessionKey: created.sessionKey,
    label: created.label,
    created: true,
    requiresChoice,
    ...(requiresChoice ? { defaultCollectionKey: created.sessionKey } : {}),
  };
}

/**
 * Resolves the collection for one save.
 *
 * - `current` (default): the pointer while it is still valid, otherwise a new
 *   `oc_<epochMs>` collection.
 * - `new`: always a new collection, which then becomes the pointer.
 * - `ask`: behaves like `current` so the product is persisted immediately, and
 *   reports `requiresChoice` so the caller can ask afterwards. A cancel can
 *   therefore never delete a saved row.
 */
export async function resolveCollectionTarget(
  input: CollectionTargetInput,
): Promise<CollectionTarget> {
  const now = input.now ?? new Date();
  const behavior =
    input.behavior ?? (await getSettings()).quickSaveCollectionBehavior;

  const pointer = await readOneClickCollection();
  const reusable =
    behavior !== 'new' && pointer ? await pointerIsReusable(pointer.sessionKey) : false;

  const requiresChoice = behavior === 'ask';

  if (reusable && pointer) {
    return {
      sessionKey: pointer.sessionKey,
      label: pointer.name,
      created: false,
      requiresChoice,
      ...(requiresChoice ? { defaultCollectionKey: pointer.sessionKey } : {}),
    };
  }

  return createAndPoint(input, now, requiresChoice);
}

/** Label for a brand-new collection, kept here so tests can assert the chain. */
export async function nextCollectionLabel(
  product: { title?: string | null; asin?: string | null },
  now: Date = new Date(),
): Promise<string> {
  return pickUniqueCollectionLabel(deriveCollectionLabel(product, now));
}
