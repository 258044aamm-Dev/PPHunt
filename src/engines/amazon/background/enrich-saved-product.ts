import { db } from '../db/database';
import { appendSnapshot, snapshotFromProduct } from '../db/quick-save';
import { formatExtractionDiagnosticsLog } from '../scraper/extraction-diagnostics';
import type { Product, ScrapedProduct } from '../types';
import { getDiagnosticsEnabled } from '../utils/diagnostics-flag';
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
  // SAD-357: full twister variations upgrade partial card swatches on enrichment;
  // weight is PDP-exclusive. Neither belongs in FILL_ONLY_FIELDS.
  'variations',
  'weight',
  // SAD-349: warranty can only come from a PDP, so a one-click save that omits
  // this would fetch the page, parse the row, and throw the value away.
  // Deliberately NOT in FILL_ONLY_FIELDS: the detail page is authoritative here
  // and neither key belongs to the price family.
  'warrantyDescription',
  'warrantyDescriptionRaw',
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

export type EnrichmentScope = 'full' | 'brand-and-rank';

export interface EnrichSavedProductInput {
  /** Omitted by saves: preserves the existing full detail policy. */
  scope?: EnrichmentScope;
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
  /**
   * SAD-369: gate for the `enrichment-parse` diagnostics line. Absent falls
   * back to the shared cached reader, so every production caller (the
   * handler's `enrich` dep and save-job recovery, which both call this
   * function directly) is gated with nothing to wire or forget.
   */
  diagnosticsEnabled?: () => boolean;
}

/**
 * Field-scoped merge: non-null detail values win, nulls never erase, and the
 * price family is skipped when the currencies disagree (a $ row must not gain a
 * € price).
 */
export function mergeDetailIntoStored(
  stored: Product,
  detail: ScrapedProduct,
  options: { skipPrice?: boolean; scope?: EnrichmentScope } = {},
): { patch: Partial<Product>; changedFields: string[] } {
  const patch: Partial<Product> = {};
  const changed: string[] = [];

  // Collection fallback may fill only these missing fields, never overwrite a
  // listing observation or leak other PDP fields through features/Prime below.
  if (options.scope === 'brand-and-rank') {
    for (const field of ['brand', 'bestSellersRank'] as const) {
      const next = detail[field];
      if (isDetailValueMissing(stored[field]) && !isDetailValueMissing(next)) {
        patch[field] = next;
        changed.push(field);
      }
    }
    return { patch, changedFields: changed };
  }

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

function isDetailValueMissing(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0)
  );
}

/**
 * SAD-352 (Phase 1a): which PDP-authoritative fields are still empty on a row.
 *
 * Driven by `DETAIL_FIELDS` (plus `features`, which the merge handles outside
 * the list) so a field added to the whitelist — e.g. SAD-349's warranty pair —
 * is measured automatically. Diagnostics only: the result feeds the outcome
 * log below and decides nothing.
 */
export function collectMissingDetailFields(product: Product): string[] {
  const missing: string[] = [];
  const record = product as unknown as Record<string, unknown>;

  for (const field of DETAIL_FIELDS) {
    if (isDetailValueMissing(record[field])) {
      missing.push(field);
    }
  }

  if (!Array.isArray(product.features) || product.features.length === 0) {
    missing.push('features');
  }

  return missing;
}

/**
 * SAD-352 (Phase 1a.2): which PDP-authoritative fields the *parsed detail
 * itself* carried — the complement view to `collectMissingDetailFields` on the
 * merged row. Session 2 showed a recurring buybox-family fingerprint
 * (price/discount/seller/delivery missing together); this separates "the
 * parser never saw the field" from "the merge declined it" (fill-only family,
 * already-known values), which `fieldsChanged` alone cannot.
 */
export function collectPresentDetailFields(detail: ScrapedProduct): string[] {
  const present: string[] = [];
  const record = detail as unknown as Record<string, unknown>;

  for (const field of DETAIL_FIELDS) {
    if (!isDetailValueMissing(record[field])) {
      present.push(field);
    }
  }

  if (Array.isArray(detail.features) && detail.features.length > 0) {
    present.push('features');
  }

  return present;
}

/** Extra context the outcome log can carry when the step reached that far. */
interface EnrichmentOutcomeExtras {
  httpStatus?: number;
  htmlBytes?: number;
  missingDetailFields?: string[];
  detailPresentFields?: string[];
  /** Fetch/parse explanation (Step 1a.2: separates the >3 MB cap from a bad content type). */
  message?: string;
}

/**
 * SAD-352 (Phase 1a): one structured console line per enrichment attempt.
 *
 * Until now a listing save's outcome, its reason and the fields it changed
 * existed only in a transient `SAVE_JOB_UPDATE` and a 2.5 s card badge, so a
 * row left at card quality could not be explained after the fact. This log is
 * the measurement that decides whether the fetch transport needs to change at
 * all (plan §8.1.1, Gate 1). Console-only by owner decision; best-effort in
 * the same style as `logFailure` — a logging failure must never fail a save,
 * and no return value anywhere depends on this function.
 *
 * Emitted as one-line JSON (Step 1a.1): session 1's pasted outcome objects
 * arrived collapsed (`fieldsChanged`/`missingDetailFields` hidden behind an
 * ellipsis), which is exactly the data Gate 1 needs.
 */
function logEnrichmentOutcome(
  input: EnrichSavedProductInput,
  startedAt: number,
  result: EnrichSavedProductResult,
  extras: EnrichmentOutcomeExtras = {},
): void {
  try {
    const payload = {
      jobId: input.jobId,
      asin: input.asin,
      scope: input.scope ?? 'full',
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(extras.httpStatus !== undefined
        ? { httpStatus: extras.httpStatus }
        : {}),
      ...(extras.htmlBytes !== undefined
        ? { htmlBytes: extras.htmlBytes }
        : {}),
      ...(extras.message ? { message: extras.message } : {}),
      fieldsChanged: result.fieldsChanged,
      ...(extras.detailPresentFields
        ? { detailPresentFields: extras.detailPresentFields }
        : {}),
      ...(extras.missingDetailFields
        ? { missingDetailFields: extras.missingDetailFields }
        : {}),
      snapshotCreated: result.snapshotCreated,
      currencyMismatch: result.currencyMismatch,
      // Wall time including the concurrency-queue wait.
      ms: Date.now() - startedAt,
    };
    console.info(`[PPHunt] enrichment outcome ${JSON.stringify(payload)}`);
  } catch {
    // Diagnostics only — never let the console break a save.
  }
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
  // SAD-369: the diagnostics are opt-in; the shared reader fails closed until
  // its first storage read resolves.
  const diagnosticsEnabled = deps.diagnosticsEnabled ?? getDiagnosticsEnabled;

  // SAD-352 (Phase 1a): every exit goes through `finish` so exactly one
  // outcome line is logged per attempt. The returned results are untouched.
  const startedAt = Date.now();
  const finish = (
    result: EnrichSavedProductResult,
    extras: EnrichmentOutcomeExtras = {},
  ): EnrichSavedProductResult => {
    logEnrichmentOutcome(input, startedAt, result, extras);
    return result;
  };

  await acquireSlot(max);
  try {
    const fetched = await fetchPdpHtml(input.productUrl, input.asin, {
      jobId: input.jobId,
      ...deps.fetchOptions,
    });

    if (fetched.status === 'skipped') {
      // A guard fired (no permission, not Amazon, breaker open): nothing was
      // attempted, so this is a skip rather than a failure.
      return finish(stop('skipped', `skipped:${fetched.reason}`), {
        message: fetched.message,
      });
    }

    if (fetched.status !== 'ok') {
      return finish(stop('failed', fetched.status, 'ENRICH_FETCH_FAILED'), {
        ...(fetched.httpStatus !== undefined
          ? { httpStatus: fetched.httpStatus }
          : {}),
        message: fetched.message,
      });
    }

    const parsed = await parse(fetched.html, input.productUrl, input.asin);

    // SAD-359: per-field extraction diagnostics for this parse (one-line JSON,
    // same jobId as the outcome line). Present on success and parser-ran
    // errors alike. Best-effort: logging must never fail the enrichment.
    try {
      if (parsed.fieldDiagnostics && diagnosticsEnabled()) {
        console.info(
          formatExtractionDiagnosticsLog(parsed.fieldDiagnostics, {
            jobId: input.jobId,
            asin: input.asin,
            stage: 'enrichment-parse',
          }),
        );
      }
    } catch {
      // Diagnostics only.
    }

    if (!parsed.ok) {
      return finish(stop('failed', parsed.code.toLowerCase(), 'ENRICH_PARSE_FAILED'), {
        httpStatus: fetched.httpStatus,
        htmlBytes: fetched.html.length,
        message: parsed.message,
      });
    }

    const detail = parsed.product;

    const stored = await db.products
      .where('[sessionKey+asin]')
      .equals([input.sessionKey, input.asin])
      .first();

    if (!stored || stored.id === undefined) {
      // Deleted while the enrichment was in flight (History delete, Clear all).
      // Re-creating it would resurrect a row the user removed.
      return finish(stop('failed', 'row-missing', 'DB_WRITE_FAILED'), {
        httpStatus: fetched.httpStatus,
        htmlBytes: fetched.html.length,
        detailPresentFields: collectPresentDetailFields(detail),
      });
    }

    const { patch, changedFields } = mergeDetailIntoStored(stored, detail, { scope: input.scope });
    const currencyMismatch =
      Boolean(stored.currency) &&
      Boolean(detail.currency) &&
      stored.currency !== detail.currency;

    if (changedFields.length > 0) {
      const updated = await db.products.update(stored.id, patch);
      if (!updated) {
        return finish(stop('failed', 'row-missing', 'DB_WRITE_FAILED'));
      }
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

    return finish(
      {
        status: complete ? 'complete' : 'partial',
        fieldsChanged: changedFields,
        snapshotCreated: snapshot.created,
        currencyMismatch,
      },
      {
        httpStatus: fetched.httpStatus,
        htmlBytes: fetched.html.length,
        detailPresentFields: collectPresentDetailFields(detail),
        // What the row still lacks after the merge — the signal that separates
        // "the PDP fetch failed" from "the fetch worked but the field was not
        // on the parsed page" (SAD-352 H1 vs H4).
        missingDetailFields: collectMissingDetailFields({
          ...stored,
          ...patch,
        } as Product),
      },
    );
  } catch (error) {
    return finish(
      stop(
        'failed',
        error instanceof Error ? error.message : 'enrichment-failed',
        'ENRICH_FETCH_FAILED',
      ),
    );
  } finally {
    releaseSlot();
  }
}
