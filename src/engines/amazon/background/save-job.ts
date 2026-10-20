import {
  ONE_CLICK_SESSION_PREFIX,
  refreshCollectionCounts,
} from '../db/collections';
import { saveQuickProduct } from '../db/quick-save';
import { rememberPendingAssignment } from './assignment';
import { resolveCollectionTarget } from './collections';
import type { JobStore } from './job-store';
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
  warning?: string;
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

export interface EnrichmentStepInput {
  jobId: string;
  asin: string;
  productUrl: string;
  sessionKey: string;
}

export interface EnrichmentStepResult {
  status: Extract<SaveEnrichmentStatus, 'complete' | 'partial' | 'failed' | 'skipped'>;
  /** Set when the step says why (partial / failed). */
  errorCode?: SaveErrorCode;
}

export interface SaveJobDeps {
  emit?: (update: SaveJobUpdate) => void;
  now?: () => Date;
  /**
   * SAD-289: the `storage.session` mirror that lets a suspended worker resume
   * this job. Absent by default, so a caller (and every existing test) that does
   * not opt in behaves exactly as before - the save itself never depends on it.
   */
  store?: JobStore;
  /** Tab that asked for the save; recovery sends its updates there. */
  tabId?: number;
  /**
   * SAD-296: runs after the row is committed. Absent by default so every
   * existing caller and test keeps the pre-enrichment behaviour exactly.
   */
  enrich?: (input: EnrichmentStepInput) => Promise<EnrichmentStepResult | void>;
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
 * SAD-335: a save must never look cleaner than it was.
 *
 * Every enrichment outcome except `complete` means the row may be missing
 * product-page fields, so each one carries a user-facing warning. Before this,
 * only `partial` warned: a `failed` or `skipped` enrichment left the toast
 * saying "Saved to …" and the card rendering a normal tick, which made blank
 * Brand / Seller / BSR / Availability cells look like a data-loss bug.
 *
 * The product row is already committed before this runs — the warning explains
 * what is missing, it never reclassifies the save as a failure.
 */
export function enrichmentWarningFor(
  status: SaveEnrichmentStatus | undefined,
  errorCode?: SaveErrorCode,
): string | undefined {
  switch (status) {
    case 'partial':
      return 'Saved, but the product page had no complete details';
    case 'skipped':
      return 'Saved, but the product page was not fetched — details may be incomplete';
    case 'failed':
      return errorCode === 'ENRICH_PARSE_FAILED'
        ? 'Saved, but the product page could not be read — details may be incomplete'
        : 'Saved, but the product details could not be fetched — details may be incomplete';
    case 'interrupted':
      return 'Saved, but the product details were interrupted — details may be incomplete';
    default:
      return undefined;
  }
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
      // SAD-343: carried on every transition so the panel can tell whether the
      // page that will show its own toast is the one the user is looking at.
      ...(deps.tabId !== undefined ? { tabId: deps.tabId } : {}),
      ...update,
    };
    // One place mirrors every transition: the store can never disagree with the
    // message the UI just received.
    deps.store?.update(jobId, {
      state: full.state,
      ...(full.enrichmentStatus ? { enrichmentStatus: full.enrichmentStatus } : {}),
    });
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

    // Registered before the first transition so a suspend *during* extraction
    // still leaves a resumable row behind.
    deps.store?.begin({
      jobId,
      asin,
      productUrl: payload.product?.url ?? '',
      ...(deps.tabId !== undefined ? { tabId: deps.tabId } : {}),
    });

    // SAD-352 (Phase 1a): diagnostics only. Pairing this line with the
    // enrichment outcome log (same `jobId`) is what lets a measurement tell
    // the trigger paths apart — and spot a listing save whose context says
    // `product-detail` (which would skip enrichment entirely). Best-effort:
    // a logging failure must never fail the save.
    try {
      console.info('[PPHunt] save job', {
        jobId,
        asin,
        pageType: payload.context?.pageType,
        triggeredBy: payload.context?.triggeredBy,
        pageUrl: payload.context?.pageUrl,
      });
    } catch {
      // Diagnostics only.
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
    deps.store?.update(jobId, { sessionKey: collection.sessionKey });

    // SAD-337: a save made *on* the product page already parsed the live DOM,
    // and `saveQuickProduct` stored it with its own `source: 'detail'` snapshot.
    // Re-fetching the same page over HTTP would duplicate that work and is the
    // single largest source of breaker trips, so this case skips enrichment
    // entirely — including the `enriching` transition, which must never show a
    // spinner for work that will not happen.
    const savedFromProductPage =
      payload.context?.pageType === 'product-detail';
    const shouldEnrich = Boolean(deps.enrich) && !savedFromProductPage;

    if (shouldEnrich) {
      // The row is already saved, so a failure here cannot lose it: the worst
      // outcome is a completed job with `enrichmentStatus: 'failed'`.
      report({
        state: 'enriching',
        collectionKey: collection.sessionKey,
        collectionLabel: collection.label,
      });
    }

    let enrichmentStatus: SaveJobUpdate['enrichmentStatus'];
    let enrichmentErrorCode: SaveJobUpdate['errorCode'];
    let enrichmentWarning: string | undefined;
    if (savedFromProductPage) {
      // The DOM parse *is* the detail read, so the save is complete.
      enrichmentStatus = 'complete';
    } else if (deps.enrich) {
      try {
        const enriched = await deps.enrich({
          jobId,
          asin,
          productUrl: payload.product.url,
          sessionKey: collection.sessionKey,
        });
        enrichmentStatus = enriched?.status;
        enrichmentErrorCode = enriched?.errorCode;
        // SAD-335: partial, failed and skipped all warn; only `complete` is silent.
        enrichmentWarning = enrichmentWarningFor(
          enrichmentStatus,
          enrichmentErrorCode,
        );
      } catch {
        enrichmentStatus = 'failed';
        enrichmentWarning = enrichmentWarningFor('failed');
      }
    }

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
      ...(enrichmentStatus ? { enrichmentStatus } : {}),
      ...(enrichmentWarning ? { warning: enrichmentWarning } : {}),
      ...(enrichmentErrorCode ? { errorCode: enrichmentErrorCode } : {}),
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
