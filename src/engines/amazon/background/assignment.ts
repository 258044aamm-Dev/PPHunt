import { createOneClickCollection } from '../db/collections';
import { db } from '../db/database';
import { getProductCountBySession } from '../db/products';
import { discardCollection, moveProductToCollection } from '../db/product-assignment';
import { writeOneClickCollection } from '../db/one-click-state';
import type { SaveJobUpdate } from './save-job';

/**
 * SAD-287 (plan 7.4 / D2): "Ask every time" is persist-first.
 *
 * The product is already in a History collection by the time the content script
 * shows the dialog, so this module can only ever *move* it. A cancel therefore
 * needs no write at all - which is what makes "cancelling never deletes the
 * record" true by construction rather than by careful ordering.
 *
 * The job registry is deliberately in memory and bounded: a pending choice is
 * only meaningful while its dialog is on screen, and a service worker restart
 * loses both the dialog and the registry entry. The row stays where it was saved,
 * which is the same outcome as a cancel.
 */

export interface PendingAssignment {
  jobId: string;
  asin: string;
  /** Collection the product was saved into before the dialog opened. */
  sessionKey: string;
  label: string;
  createdAt: string;
}

export interface AssignSavedProductInput {
  jobId: string;
  choice: 'current' | 'new';
}

export interface AssignSavedProductDeps {
  now?: () => Date;
  emit?: (update: SaveJobUpdate) => void;
}

/** Keep the registry small; a real queue of unanswered dialogs is 1-2 deep. */
export const MAX_PENDING_ASSIGNMENTS = 20;
/** A dialog that has been gone this long can no longer be answered. */
export const PENDING_ASSIGNMENT_TTL_MS = 10 * 60 * 1000;

const pending = new Map<string, PendingAssignment>();

export function resetPendingAssignmentsForTests(): void {
  pending.clear();
}

/** Drops entries older than the TTL and, if still over the cap, the oldest ones. */
function prunePending(nowMs: number): void {
  for (const [jobId, entry] of pending) {
    const createdAt = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdAt) || nowMs - createdAt > PENDING_ASSIGNMENT_TTL_MS) {
      pending.delete(jobId);
    }
  }

  while (pending.size > MAX_PENDING_ASSIGNMENTS) {
    const oldest = pending.keys().next();
    if (oldest.done) return;
    pending.delete(oldest.value);
  }
}

/** Remembers that `jobId` completed and is waiting for an Ask-every-time answer. */
export function rememberPendingAssignment(
  assignment: PendingAssignment,
  nowMs: number = Date.now(),
): void {
  pending.set(assignment.jobId, assignment);
  prunePending(nowMs);
}

export function getPendingAssignment(
  jobId: string,
  nowMs: number = Date.now(),
): PendingAssignment | undefined {
  prunePending(nowMs);
  return pending.get(jobId);
}

export function pendingAssignmentCount(): number {
  return pending.size;
}

function plural(count: number): string {
  return count === 1 ? 'product' : 'products';
}

/**
 * Applies the dialog answer.
 *
 * - `current`: nothing to do, the product is already there. Emits a resolution
 *   update so a client that tracks the job stops waiting for an answer.
 * - `new`: mints a fresh `oc_<ts>` collection, moves the product **and its
 *   snapshots** in one transaction, then repoints the pointer. If the target was
 *   created but the move failed, the empty target is discarded so the History
 *   list is unchanged.
 *
 * Returns `null` for an unknown job (stale dialog, worker restart). Callers treat
 * that as "nothing to do", never as an error.
 */
export async function handleAssignSavedProduct(
  input: AssignSavedProductInput,
  deps: AssignSavedProductDeps = {},
): Promise<SaveJobUpdate | null> {
  const now = deps.now ?? (() => new Date());
  const assignment = getPendingAssignment(input.jobId);
  if (!assignment) return null;

  const timestamp = () => now().toISOString();
  const emit = (
    update: Omit<SaveJobUpdate, 'jobId' | 'asin' | 'updatedAt'>,
  ): SaveJobUpdate => {
    const full: SaveJobUpdate = {
      jobId: assignment.jobId,
      asin: assignment.asin,
      updatedAt: timestamp(),
      ...update,
    };
    deps.emit?.(full);
    return full;
  };

  if (input.choice === 'current') {
    pending.delete(assignment.jobId);
    const count = await getProductCountBySession(assignment.sessionKey).catch(
      () => 0,
    );
    return emit({
      state: 'completed',
      collectionKey: assignment.sessionKey,
      collectionLabel: assignment.label,
      message: `Kept in ${assignment.label} · ${count} ${plural(count)}`,
    });
  }

  const productRow = await db.products
    .where('[sessionKey+asin]')
    .equals([assignment.sessionKey, assignment.asin])
    .first();

  if (!productRow) {
    // The row was deleted (another tab, Clear history) while the dialog was
    // open. There is nothing to move and nothing to repair.
    pending.delete(assignment.jobId);
    return emit({
      state: 'failed',
      errorCode: 'DB_WRITE_FAILED',
      message: 'This product is no longer in History',
    });
  }

  const created = await createOneClickCollection({
    pageUrl: productRow.url,
    product: { title: productRow.title, asin: productRow.asin },
    now: now(),
  });

  try {
    const moved = await moveProductToCollection({
      asin: assignment.asin,
      fromSessionKey: assignment.sessionKey,
      toSessionKey: created.sessionKey,
      now: now(),
    });

    await writeOneClickCollection({
      sessionKey: created.sessionKey,
      name: created.label,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    });

    pending.delete(assignment.jobId);

    return emit({
      state: 'completed',
      collectionKey: created.sessionKey,
      collectionLabel: created.label,
      message: `Moved to ${created.label} · ${moved.toCount} ${plural(moved.toCount)}`,
    });
  } catch (error) {
    // The move transaction rolled back; drop the empty collection it was aimed at
    // so the History list looks exactly as it did before the dialog opened.
    try {
      await discardCollection(created.sessionKey);
    } catch {
      // Best effort: an empty collection is a cosmetic defect, not data loss.
    }

    pending.delete(assignment.jobId);

    return emit({
      state: 'failed',
      errorCode: 'DB_WRITE_FAILED',
      message:
        error instanceof Error && error.message
          ? `Could not move: ${error.message}`
          : 'Could not move this product',
    });
  }
}
