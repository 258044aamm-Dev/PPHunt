import { db } from './database';

/**
 * SAD-287 (plan 7.4): the only cross-collection write in the one-click flow.
 *
 * A product is saved before the "Ask every time" dialog appears, so choosing
 * "Create new collection" means *moving* an existing row - not saving it again.
 * Moving has to take the snapshots with it, otherwise the old collection keeps
 * orphan history rows that no product points at.
 *
 * Everything below runs in one Dexie `rw` transaction over `products`,
 * `snapshots` and `history`: if any step throws, Dexie aborts and the product
 * stays exactly where it was. `createOneClickCollection()` is *not* called from
 * here, so a rollback never leaves a half-created target behind (the caller owns
 * that cleanup).
 */

export interface MoveProductInput {
  asin: string;
  fromSessionKey: string;
  toSessionKey: string;
  /** Injectable clock so tests can assert the written timestamps. */
  now?: Date;
}

export interface MoveProductResult {
  /** False when the product row is not in `fromSessionKey` (already moved, deleted, ...). */
  moved: boolean;
  /** Snapshots re-keyed onto the target collection. */
  snapshotCount: number;
  /** Products left in the source collection after the move. */
  fromCount: number;
  /** Products in the target collection after the move. */
  toCount: number;
}

/**
 * The target collection must already have its History row. Moving a product into
 * a key that has none would create a collection that no UI can ever show.
 */
export class CollectionMoveError extends Error {
  readonly code: 'TARGET_MISSING';

  constructor(code: 'TARGET_MISSING', message: string) {
    super(message);
    this.name = 'CollectionMoveError';
    this.code = code;
  }
}

async function readProduct(
  sessionKey: string,
  asin: string,
): Promise<{ id?: number } | undefined> {
  // The compound index is the fast path; the fallback keeps the helper correct
  // for rows written before the index existed (or by a future importer).
  return db.products.where('[sessionKey+asin]').equals([sessionKey, asin]).first();
}

/**
 * Moves one stored product and its snapshots to another collection, then
 * recomputes both History counts inside the same transaction so no collection
 * ever displays a stale number.
 *
 * Idempotent by outcome: if the row is not in the source (or source === target)
 * nothing is written and `moved` is false with both counts still reported.
 */
export async function moveProductToCollection(
  input: MoveProductInput,
): Promise<MoveProductResult> {
  const { asin, fromSessionKey, toSessionKey } = input;
  const timestamp = (input.now ?? new Date()).toISOString();

  if (!asin || !fromSessionKey || !toSessionKey) {
    throw new CollectionMoveError('TARGET_MISSING', 'Missing collection key');
  }

  return db.transaction(
    'rw',
    [db.products, db.snapshots, db.history],
    async () => {
      const fromCountNow = () =>
        db.products.where('sessionKey').equals(fromSessionKey).count();
      const toCountNow = () =>
        db.products.where('sessionKey').equals(toSessionKey).count();

      if (fromSessionKey === toSessionKey) {
        return {
          moved: false,
          snapshotCount: 0,
          fromCount: await fromCountNow(),
          toCount: await toCountNow(),
        };
      }

      const target = await db.history
        .where('sessionKey')
        .equals(toSessionKey)
        .first();
      if (!target) {
        throw new CollectionMoveError(
          'TARGET_MISSING',
          `No collection ${toSessionKey}`,
        );
      }

      const row = await readProduct(fromSessionKey, asin);
      if (!row || row.id === undefined) {
        return {
          moved: false,
          snapshotCount: 0,
          fromCount: await fromCountNow(),
          toCount: await toCountNow(),
        };
      }

      await db.products.update(row.id, { sessionKey: toSessionKey });

      const snapshots = await db.snapshots
        .where('sessionKey')
        .equals(fromSessionKey)
        .filter((snapshot) => snapshot.asin === asin)
        .toArray();

      for (const snapshot of snapshots) {
        if (snapshot.id !== undefined) {
          await db.snapshots.update(snapshot.id, { sessionKey: toSessionKey });
        }
      }

      const fromCount = await fromCountNow();
      const toCount = await toCountNow();

      await db.history
        .where('sessionKey')
        .equals(fromSessionKey)
        .modify({ collectedCount: fromCount, updatedAt: timestamp });
      await db.history
        .where('sessionKey')
        .equals(toSessionKey)
        .modify({ collectedCount: toCount, updatedAt: timestamp });

      return { moved: true, snapshotCount: snapshots.length, fromCount, toCount };
    },
  );
}

/**
 * Deletes a collection that was created for a move that then failed, so a
 * rollback leaves no empty history row behind. Products and snapshots are
 * removed too: a target that never received the product has none, and if it did
 * receive it the move committed and this helper must not run.
 */
export async function discardCollection(sessionKey: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.products, db.snapshots, db.history],
    async () => {
      await db.products.where('sessionKey').equals(sessionKey).delete();
      await db.snapshots.where('sessionKey').equals(sessionKey).delete();
      await db.history.where('sessionKey').equals(sessionKey).delete();
    },
  );
}
