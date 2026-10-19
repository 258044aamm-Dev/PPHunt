import {
  ONE_CLICK_SESSION_PREFIX,
  createOneClickCollection,
  refreshCollectionCounts,
} from '../db/collections';
import {
  readOneClickCollection,
  writeOneClickCollection,
  type OneClickCollectionPointer,
} from '../db/one-click-state';
import { saveQuickProduct } from '../db/quick-save';
import { getHistoryBySessionKey } from '../db/history';
import type {
  SaveEnrichmentStatus,
  SaveErrorCode,
  SaveExtractionContext,
  SaveJobState,
  ScrapedProduct,
} from '../types';

/**
 * SAD-281 (plan 9): the smallest save pipeline that proves the chain
 * right-click -> History. Enrichment (P2) and export (P4) attach to the same
 * shape later; nothing here assumes they exist.
 */

export interface SaveJobUpdate {
  jobId: string;
  asin: string;
  state: SaveJobState;
  enrichmentStatus?: SaveEnrichmentStatus;
  collectionKey?: string;
  collectionLabel?: string;
  message?: string;
  errorCode?: SaveErrorCode;
  updatedAt: string;
}

export interface SaveProductPayload {
  jobId: string;
  product: ScrapedProduct;
  context: SaveExtractionContext;
}

export interface SaveJobDeps {
  emit?: (update: SaveJobUpdate) => void;
  now?: () => Date;
}

/** Jobs currently writing. A repeated `SAVE_PRODUCT` with the same id is ignored. */
const inFlightJobs = new Set<string>();

export function resetSaveJobsForTests(): void {
  inFlightJobs.clear();
}

export interface ResolvedCollection {
  sessionKey: string;
  label: string;
  created: boolean;
}

/**
 * Reuses the stored pointer while its history row still exists; otherwise makes
 * a new one-click collection. A pointer to a deleted collection must never
 * resurrect it (plan 7.3).
 */
export async function resolveOneClickCollection(
  pageUrl: string,
  product: { title?: string | null; asin?: string | null },
  now: Date = new Date(),
): Promise<ResolvedCollection> {
  const pointer = await readOneClickCollection();

  if (pointer) {
    const row = await getHistoryBySessionKey(pointer.sessionKey);
    if (row) {
      return { sessionKey: pointer.sessionKey, label: pointer.label, created: false };
    }
  }

  const created = await createOneClickCollection({ pageUrl, product, now });
  const next: OneClickCollectionPointer = {
    sessionKey: created.sessionKey,
    label: created.label,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await writeOneClickCollection(next);

  return { sessionKey: created.sessionKey, label: created.label, created: true };
}

function savedMessage(label: string, count: number): string {
  const products = count === 1 ? 'product' : 'products';
  return `Saved to ${label} · ${count} ${products}`;
}

/**
 * Writes one product plus its snapshot, refreshes the collection count from the
 * database and reports each transition. Any failure reports `failed` - never a
 * completed state for a transaction that did not commit.
 */
export async function handleSaveProduct(
  payload: SaveProductPayload,
  deps: SaveJobDeps = {},
): Promise<SaveJobUpdate> {
  const now = deps.now ?? (() => new Date());
  const timestamp = () => now().toISOString();
  const jobId = payload.jobId;
  const asin = payload.product?.asin ?? '';

  const report = (update: Omit<SaveJobUpdate, 'jobId' | 'asin' | 'updatedAt'>) => {
    const full: SaveJobUpdate = {
      jobId,
      asin,
      updatedAt: timestamp(),
      ...update,
    };
    deps.emit?.(full);
    return full;
  };

  if (inFlightJobs.has(jobId)) {
    return report({ state: 'extracting', message: 'Already saving' });
  }

  inFlightJobs.add(jobId);

  try {
    if (!asin) {
      // `SAVE_JOB_UPDATE` requires a valid ASIN, so a product-less job cannot be
      // reported over the wire. The content script owns that message ("no product
      // found here") and never sends one; this guard is the last line of defence
      // and stays silent rather than emitting a message the receiver rejects.
      return {
        jobId,
        asin,
        state: 'failed',
        errorCode: 'NO_PRODUCT',
        message: 'No product found here',
        updatedAt: timestamp(),
      };
    }

    report({ state: 'extracting' });

    const collection = await resolveOneClickCollection(
      payload.context?.pageUrl ?? '',
      payload.product,
      now(),
    );

    await saveQuickProduct({
      product: payload.product,
      sessionKey: collection.sessionKey,
      jobId,
      source: payload.context?.pageType === 'product-detail' ? 'detail' : 'listing',
      collectedAt: timestamp(),
      context: payload.context,
    });

    const count = await refreshCollectionCounts(collection.sessionKey, now());

    return report({
      state: 'completed',
      collectionKey: collection.sessionKey,
      collectionLabel: collection.label,
      message: savedMessage(collection.label, count),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? `Could not save: ${error.message}`
        : 'Could not save this product';

    return report({
      state: 'failed',
      errorCode: 'DB_WRITE_FAILED',
      message,
    });
  } finally {
    inFlightJobs.delete(jobId);
  }
}

/** True when a collection key was produced by the one-click flow. */
export function isOneClickCollectionKey(sessionKey: string | null | undefined): boolean {
  return Boolean(sessionKey && sessionKey.startsWith(ONE_CLICK_SESSION_PREFIX));
}
