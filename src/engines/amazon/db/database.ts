import Dexie, { type Table } from 'dexie';
import type {
  AppSettings,
  HistoryEntry,
  Product,
  ProductSnapshot,
  SessionState,
} from '../types';
import { sanitizeAvailabilityText } from '../utils/availability-text';

/**
 * Clean-slate Dexie IndexedDB database (`PPHuntDB`) for the Amazon engine.
 * Completely isolated from `PPHuntTemuDB`.
 */
export class PPHuntDB extends Dexie {
  products!: Table<Product, number>;
  sessions!: Table<SessionState, string>;
  history!: Table<HistoryEntry, number>;
  settings!: Table<AppSettings, string>;
  snapshots!: Table<ProductSnapshot, number>;

  constructor(name = 'PPHuntDB') {
    super(name);

    this.version(1).stores({
      products: '++id, asin, sessionKey, collectedAt, [sessionKey+asin]',
      sessions: 'id, tabId, status, startedAt, updatedAt',
      history: '++id, sessionKey, startedAt, completedAt, status',
      settings: 'id',
    });

    // v2 (SAD-275): one row per observation, so re-saving a product records the
    // new price/rating/BSR instead of overwriting the only copy. Additive only:
    // the v1 stores are inherited untouched and no row is rewritten on upgrade.
    this.version(2).stores({
      snapshots: '++id, asin, sessionKey, capturedAt, [asin+capturedAt]',
    });

    // v3 (SAD-392): one-time cleanup of availability values polluted by
    // embedded <script> text that `textContent` reads serialized before the
    // write-side fix (the reported variant's AOD-loader blob, the span-less
    // buybox's a-state JSON). Data-only upgrade: no store shape changes
    // (`{}` inherits the v2 schema), only `availability` is touched, and only
    // on rows whose value actually changes. The upgrade must NEVER throw: a
    // failed Dexie upgrade blocks every DB open (side panel, worker) and
    // would take the whole extension down — so the whole body and each table
    // are fault-contained, and malformed rows are skipped, not guessed at.
    this.version(3)
      .stores({})
      .upgrade(async (tx) => {
        const cleanTable = async (name: 'products' | 'snapshots'): Promise<void> => {
          try {
            await tx
              .table(name)
              .toCollection()
              .modify((row) => {
                const current = row.availability;
                // Rows without the key keep not having it — never add fields.
                // NOTE: Dexie 4's Collection.modify skips the write only when
                // the callback returns `false` (source: `modifyer(...) !==
                // false` gates the put — `0` would rewrite every row); this
                // was measured with 'updating' hooks in the step-4 tests.
                if (current === undefined) return false;
                const next = sanitizeAvailabilityText(current);
                // Clean, null and malformed rows are left untouched — no
                // write at all, so a re-run of this pass is a no-op.
                if (next === current) return false;
                row.availability = next;
              });
          } catch {
            // Contained: an unreadable row never blocks the upgrade or the
            // DB open.
          }
        };
        await cleanTable('products');
        await cleanTable('snapshots'); // D2b: snapshots carry the projected availability
      });
  }
}

export const db = new PPHuntDB();
