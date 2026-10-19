import {
  ONE_CLICK_SESSION_PREFIX,
  refreshCollectionCounts,
} from '../db/collections';
import { saveQuickProduct } from '../db/quick-save';
import { rememberPendingAssignment } from './assignment';
import { resolveCollectionTarget } from './collections';
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
  requiresCollectionChoice?: boolean;
  defaultCollectionKey?: string;
  /** Product name for the Ask-every-time dialog; never fabricated, omitted when null. */
  productTitle?: string;
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
/**
 * asin -> jobId for jobs still writing. A second save of the same product while
 * the first is running returns the running job instead of starting a rival one
 * (plan 8.4). Keyed by ASIN rather than by collection: the collection is not
 * known until it resolves, and one product can only be heading to one place.
 */
const inFlightByAsin = new Map<string, string>();

export function resetSaveJobsForTests(): void {
  inFlightJobs.clear();
  inFlightByAsin.clear();
}

export type ResolvedCollection = Awaited<ReturnType<typeof resolveCollectionTarget>>;

/**
 * Reuses the stored pointer while it is still valid; otherwise makes a new
 * one-click collection. Delegates every guard - stale row, full-page run,
 * `new`/`ask` behaviour - to `resolveCollectionTarget` (plan 7.1-7.3).
 */
export async function resolveOneClickCollection(
  pageUrl: string,
  product: { title?: string | null; asin?: string | null },
  now: Date = new Date(),
): Promise<ResolvedCollection> {
  return resolveCollectionTarget({ pageUrl, product, now });
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

    const runningJobId = inFlightByAsin.get(asin);
    if (runningJobId) {
      // Report against the running job, not the duplicate, so a client that
      // tracks job ids cannot mistake this for a new job.
      const duplicate: SaveJobUpdate = {
        jobId: runningJobId,
        asin,
        state: 'extracting',
        message: 'Already saving',
        updatedAt: timestamp(),
      };
      deps.emit?.(duplicate);
      return duplicate;
    }
    inFlightByAsin.set(asin, jobId);

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

    if (collection.requiresChoice) {
      // Registered before the update is emitted: the dialog can be answered the
      // moment the content script receives it, so the entry must already exist.
      rememberPendingAssignment({
        jobId,
        asin,
        sessionKey: collection.sessionKey,
        label: collection.label,
        createdAt: timestamp(),
      });
    }

    return report({
      state: 'completed',
      collectionKey: collection.sessionKey,
      collectionLabel: collection.label,
      message: savedMessage(collection.label, count),
      ...(payload.product?.title ? { productTitle: payload.product.title } : {}),
      ...(collection.requiresChoice
        ? {
            requiresCollectionChoice: true,
            defaultCollectionKey: collection.defaultCollectionKey,
          }
        : {}),
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
    if (inFlightByAsin.get(asin) === jobId) {
      inFlightByAsin.delete(asin);
    }
  }
}

/** True when a collection key was produced by the one-click flow. */
export function isOneClickCollectionKey(sessionKey: string | null | undefined): boolean {
  return Boolean(sessionKey && sessionKey.startsWith(ONE_CLICK_SESSION_PREFIX));
}
