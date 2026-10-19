import { db } from '../db/database';
import { appendSnapshot, snapshotFromProduct } from '../db/quick-save';
import type { Product, ScrapedProduct } from '../types';
import { fetchPdpHtml, type FetchPdpOptions } from './enrichment-fetch';
import { parsePdpHtmlViaOffscreen } from './offscreen';

/**
 * SAD-296 (plan 10.3): turn a fetched PDP into an update of the row that is
 * already saved.
 *
 * Two rules shape everything here:
 *
 * 1. **The row already exists.** Enrichment is an upgrade, never a write path:
 *    if the product was deleted, if the fetch failed, or if the parse produced
 *    nothing, the row is left byte-identical and the job only reports a status.
 * 2. **Only product fields are merged.** `mergeScrapedProductFields()` is built
 *    for two listing observations and rewrites placement/category/sponsorship
 *    context; running a PDP (which has none of that) through it would erase the
 *    listing context of a row saved from search. The field list below is
 *    deliberate and the merge is scoped to it.
 *
 * Concurrency is bounded: a burst of saves must not open a dozen PDP requests,
 * because that is the fastest way to get rate-limited.
 */

export const MAX_CONCURRENT_ENRICHMENTS = 2;

/** Fields a product-detail page is authoritative for. */
const DETAIL_FIELDS = [
  'title',
  'price',
  'listPrice',
  'discountPercentage',
  'rating',
  'reviewCount',
  'bestSellersRank',
  'availability',
  'seller',
  'brand',
  'description',
  'imageUrl',
  'coupon',
  'delivery',
  'dealBadge',
  'pastMonthSales',
  'badge',
] as const;

/**
 * SAD-296: the listing values the user actually saw when they saved win over
 * the PDP. A re-save from a search card must not silently change the price the
 * row was saved with; the detail observation is kept in the snapshot instead.
 */
const FILL_ONLY_FIELDS = new Set<string>([
  'price',
  'listPrice',
  'discountPercentage',
  'availability',
  'currency',
]);

export const PRICE_FAMILY = FILL_ONLY_FIELDS;

export interface EnrichSavedProductInput {
  jobId: string;
  asin: string;
  productUrl: string;
  sessionKey: string;
  now?: Date;
}

export type EnrichmentStatus = 'complete' | 'partial' | 'failed' | 'skipped';

export type EnrichmentErrorCode =
  | 'ENRICH_FETCH_FAILED'
  | 'ENRICH_PARSE_FAILED'
  | 'DB_WRITE_FAILED';

export interface EnrichSavedProductResult {
  status: EnrichmentStatus;
  /** Fields the detail page actually changed on the stored row. */
  fieldsChanged: string[];
  snapshotCreated: boolean;
  /** Why enrichment did not produce a complete product (fetch/parse status). */
  reason?: string;
  /** Set only when `status` is `failed`. */
  errorCode?: EnrichmentErrorCode;
  currencyMismatch: boolean;
}

export interface EnrichSavedProductDeps {
  fetchOptions?: FetchPdpOptions;
  parse?: typeof parsePdpHtmlViaOffscreen;
  maxConcurrent?: number;
  now?: () => Date;
}

/**
 * Field-scoped merge: non-null detail values win, nulls never erase, and the
 * price family is skipped when the currencies disagree (a $ row must not gain a
 * € price).
 */
export function mergeDetailIntoStored(
  stored: Product,
  detail: ScrapedProduct,
  options: { skipPrice?: boolean } = {},
): { patch: Partial<Product>; changedFields: string[] } {
  const patch: Partial<Product> = {};
  const changed: string[] = [];

  const currencyMismatch =
    Boolean(stored.currency) &&
    Boolean(detail.currency) &&
    stored.currency !== detail.currency;
  const skipPrice = options.skipPrice || currencyMismatch;

  for (const field of DETAIL_FIELDS) {
    if (skipPrice && PRICE_FAMILY.has(field)) continue;

    const next = detail[field];
    if (next === null || next === undefined) continue;
    if (typeof next === 'string' && next.trim().length === 0) continue;

    const current = stored[field];
    if (current === next) continue;

    // Fill-only fields keep whatever the user's save already recorded.
    if (FILL_ONLY_FIELDS.has(field) && current !== null && current !== undefined) {
      continue;
    }

    (patch as Record<string, unknown>)[field] = next;
    changed.push(field);
  }

  const detailFeatures = detail.features;
  if (Array.isArray(detailFeatures) && detailFeatures.length > 0) {
    const current = stored.features ?? [];
    if (current.join('\u0000') !== detailFeatures.join('\u0000')) {
      patch.features = detailFeatures;
      changed.push('features');
    }
  }

  if (detail.isPrime && !stored.isPrime) {
    patch.isPrime = true;
    changed.push('isPrime');
  }

  return { patch, changedFields: changed };
}

let activeEnrichments = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(max: number): Promise<void> {
  if (activeEnrichments < max) {
    activeEnrichments += 1;
    return;
  }

  await new Promise<void>((resolve) => waiting.push(resolve));
  activeEnrichments += 1;
}

function releaseSlot(): void {
  activeEnrichments = Math.max(0, activeEnrichments - 1);
  const next = waiting.shift();
  if (next) next();
}

export function resetEnrichmentConcurrencyForTests(): void {
  activeEnrichments = 0;
  waiting.length = 0;
}

function stop(
  status: 'failed' | 'skipped',
  reason: string,
  errorCode?: EnrichmentErrorCode,
): EnrichSavedProductResult {
  return {
    status,
    fieldsChanged: [],
    snapshotCreated: false,
    reason,
    ...(errorCode ? { errorCode } : {}),
    currencyMismatch: false,
  };
}

/**
 * Fetches, parses and merges one saved product.
 *
 * Never throws: a failed enrichment returns `status: 'failed'` and the caller
 * keeps the listing data it already has.
 */
export async function enrichSavedProduct(
  input: EnrichSavedProductInput,
  deps: EnrichSavedProductDeps = {},
): Promise<EnrichSavedProductResult> {
  const max = Math.max(1, deps.maxConcurrent ?? MAX_CONCURRENT_ENRICHMENTS);
  const parse = deps.parse ?? parsePdpHtmlViaOffscreen;

  await acquireSlot(max);
  try {
    const fetched = await fetchPdpHtml(input.productUrl, input.asin, {
      jobId: input.jobId,
      ...deps.fetchOptions,
    });

    if (fetched.status === 'skipped') {
      // A guard fired (no permission, not Amazon, breaker open): nothing was
      // attempted, so this is a skip rather than a failure.
      return stop('skipped', `skipped:${fetched.reason}`);
    }

    if (fetched.status !== 'ok') {
      return stop('failed', fetched.status, 'ENRICH_FETCH_FAILED');
    }

    const parsed = await parse(fetched.html, input.productUrl, input.asin);
    if (!parsed.ok) {
      return stop('failed', parsed.code.toLowerCase(), 'ENRICH_PARSE_FAILED');
    }

    const detail = parsed.product;

    const stored = await db.products
      .where('[sessionKey+asin]')
      .equals([input.sessionKey, input.asin])
      .first();

    if (!stored || stored.id === undefined) {
      // Deleted while the enrichment was in flight (History delete, Clear all).
      // Re-creating it would resurrect a row the user removed.
      return stop('failed', 'row-missing', 'DB_WRITE_FAILED');
    }

    const { patch, changedFields } = mergeDetailIntoStored(stored, detail);
    const currencyMismatch =
      Boolean(stored.currency) &&
      Boolean(detail.currency) &&
      stored.currency !== detail.currency;

    if (changedFields.length > 0) {
      await db.products.update(stored.id, patch);
    }

    const snapshot = await appendSnapshot(
      snapshotFromProduct(detail, {
        sessionKey: input.sessionKey,
        jobId: input.jobId,
        source: 'detail',
        capturedAt: (input.now ?? deps.now?.() ?? new Date()).toISOString(),
      }),
    );

    // `complete` requires the two fields a PDP is fetched for. A buybox-less or
    // variant page parses cleanly with `price: null`; that is `partial`, not a
    // failure, because the row is already saved and the listing price survives.
    const complete = Boolean(detail.title) && detail.price !== null && detail.price !== undefined;

    return {
      status: complete ? 'complete' : 'partial',
      fieldsChanged: changedFields,
      snapshotCreated: snapshot.created,
      currencyMismatch,
    };
  } catch (error) {
    return stop(
      'failed',
      error instanceof Error ? error.message : 'enrichment-failed',
      'ENRICH_FETCH_FAILED',
    );
  } finally {
    releaseSlot();
  }
}
