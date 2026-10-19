import { db } from '../db/database';
import type { ProductSnapshot } from '../types';
import { enrichSavedProduct } from './enrich-saved-product';
import { dispatchToAmazonTab } from './handler';
import {
  MAX_SAVE_JOB_REQUEUES,
  isResumableState,
  saveJobStore,
  type JobStore,
  type SaveJobRecord,
} from './job-store';
import type { SaveJobUpdate } from './save-job';

/**
 * SAD-289 (plan 10.4 / R8): what happens to a save whose service worker was
 * suspended mid-flight.
 *
 * The invariant that makes this safe: **the product row is written before
 * enrichment starts** (§9 step 4). So recovery never re-saves anything - it
 * looks for the listing snapshot the interrupted save already wrote and, at
 * most once, redoes the enrichment step. A job with no listing snapshot never
 * reached the database and is reported as failed rather than guessed at.
 *
 * Idempotency comes from three guards: `attempts` caps the re-runs at one, an
 * existing detail snapshot is treated as "already enriched", and the terminal
 * state is written back to the mirror immediately.
 */

export interface RecoveryDeps {
  store: JobStore;
  enrich: (input: {
    jobId: string;
    asin: string;
    productUrl: string;
    sessionKey: string;
  }) => Promise<{ status: 'complete' | 'partial' | 'failed' | 'skipped' }>;
  emit: (update: SaveJobUpdate) => void;
  now?: () => Date;
  maxRequeues?: number;
  /** Injectable for tests; defaults to a scan of this ASIN's snapshots. */
  findSnapshots?: (record: SaveJobRecord) => Promise<ProductSnapshot[]>;
}

export interface RecoveryReport {
  resumed: number;
  interrupted: number;
  failed: number;
  dropped: number;
}

async function defaultFindSnapshots(record: SaveJobRecord): Promise<ProductSnapshot[]> {
  try {
    return await db.snapshots.where('asin').equals(record.asin).toArray();
  } catch {
    return [];
  }
}

function buildUpdate(
  record: SaveJobRecord,
  now: () => Date,
  patch: Omit<SaveJobUpdate, 'jobId' | 'asin' | 'updatedAt'>,
): SaveJobUpdate {
  return {
    jobId: record.jobId,
    asin: record.asin,
    updatedAt: now().toISOString(),
    ...patch,
  };
}

/**
 * Resumes every resumable job found in the mirror.
 *
 * Called once per worker start (and safe to call again: a second call finds
 * nothing left in a resumable state unless a new job started meanwhile).
 */
export async function recoverSaveJobs(
  deps: RecoveryDeps,
): Promise<RecoveryReport> {
  const now = deps.now ?? (() => new Date());
  const maxRequeues = deps.maxRequeues ?? MAX_SAVE_JOB_REQUEUES;
  const findSnapshots = deps.findSnapshots ?? defaultFindSnapshots;

  const { kept, dropped } = await deps.store.hydrate();
  const report: RecoveryReport = { resumed: 0, interrupted: 0, failed: 0, dropped };

  for (const record of kept) {
    if (!isResumableState(record.state)) continue;

    const snapshots = await findSnapshots(record);
    const listing = snapshots.find((snapshot) => snapshot.jobId === record.jobId);

    if (!listing) {
      // The save never committed: nothing in History is missing, and there is no
      // product payload to re-run (it was never persisted). Say so, stop the
      // spinner, and move on.
      deps.store.update(record.jobId, { state: 'failed' });
      deps.emit(
        buildUpdate(record, now, {
          state: 'failed',
          errorCode: 'DB_WRITE_FAILED',
          message: 'The save was interrupted before it was stored',
        }),
      );
      report.failed += 1;
      continue;
    }

    const sessionKey = record.sessionKey ?? listing.sessionKey;
    const alreadyEnriched = snapshots.some(
      (snapshot) => snapshot.jobId === record.jobId && snapshot.source === 'detail',
    );

    if (alreadyEnriched) {
      // The enrichment landed; only the completion message was lost.
      deps.store.update(record.jobId, { state: 'completed', sessionKey });
      deps.emit(
        buildUpdate(record, now, {
          state: 'completed',
          collectionKey: sessionKey,
          message: 'Saved to History',
        }),
      );
      report.resumed += 1;
      continue;
    }

    if (record.attempts >= maxRequeues) {
      // It died again after a re-run. Do not loop: the row is safe, the details
      // may be stale, and the card must stop spinning.
      deps.store.update(record.jobId, {
        state: 'completed',
        enrichmentStatus: 'interrupted',
        sessionKey,
      });
      deps.emit(
        buildUpdate(record, now, {
          state: 'completed',
          collectionKey: sessionKey,
          enrichmentStatus: 'interrupted',
          warning: 'Saved, but details could not be refreshed',
          message: 'Saved to History',
        }),
      );
      report.interrupted += 1;
      continue;
    }

    deps.store.update(record.jobId, {
      attempts: record.attempts + 1,
      state: 'enriching',
      sessionKey,
    });

    let status: 'complete' | 'partial' | 'failed' | 'skipped' = 'failed';
    try {
      const result = await deps.enrich({
        jobId: record.jobId,
        asin: record.asin,
        productUrl: record.productUrl,
        sessionKey,
      });
      status = result.status;
    } catch {
      status = 'failed';
    }

    deps.store.update(record.jobId, {
      state: 'completed',
      enrichmentStatus: status,
      sessionKey,
    });
    deps.emit(
      buildUpdate(record, now, {
        state: 'completed',
        collectionKey: sessionKey,
        enrichmentStatus: status,
        message: 'Saved to History',
      }),
    );
    report.resumed += 1;
  }

  // Anything older than the TTL leaves the mirror on every recovery pass.
  report.dropped += deps.store.sweep();

  return report;
}

/**
 * Production wiring: the shared store, the real enrichment step and the two
 * channels a `SAVE_JOB_UPDATE` has to reach (the tab that started the job, and
 * the side panel).
 */
export async function recoverAmazonSaveJobs(): Promise<RecoveryReport> {
  return recoverSaveJobs({
    store: saveJobStore,
    enrich: (input) => enrichSavedProduct(input),
    emit: (update) => {
      const message = { type: 'SAVE_JOB_UPDATE', payload: update };
      const record = saveJobStore.get(update.jobId);
      if (record?.tabId !== undefined) {
        void dispatchToAmazonTab(record.tabId, message);
      }
      try {
        const api =
          typeof browser === 'undefined'
            ? undefined
            : (browser as { runtime?: { sendMessage?: (m: unknown) => unknown } });
        const result = api?.runtime?.sendMessage?.(message);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(() => {});
        }
      } catch {
        // The panel may not be open; the tab channel above is the important one.
      }
    },
  });
}
