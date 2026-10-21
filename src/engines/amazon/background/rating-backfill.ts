/**
 * SAD-383: fill the two fields a listing card may not print.
 *
 * A save and a collection parse the same card, so both see the same card values.
 * The difference is what happens next: a save continues into `enrichSavedProduct`
 * and reads the product page, while a collection stops at the card — which is why
 * a `/deals` card (no rating node at all, measured 2026-10-21) produced a rating
 * on save and nothing on collection.
 *
 * This pump closes that gap for exactly those two fields, and nothing else. It
 * deliberately does not re-use SAD-379's `enrichment-pump`: that pipeline merges
 * 21 detail fields, writes snapshots and answers to its own switch, and widening
 * it would change a contract another ticket already shipped and tested. Two small
 * modules, two independent switches.
 *
 * The rules are the ones the enrichment pump established, for the same reasons:
 *
 * 1. **Never blocks the collection.** `enqueueRatingBackfill` returns immediately
 *    and the runner is never awaited by `pendingProductsChain`, so progress and
 *    Stop Collection do not wait on a request.
 * 2. **Never twice per run.** `(sessionKey, asin)` is queued once, even though an
 *    `updatedExisting` batch re-sends the whole run.
 * 3. **Stops when the host says stop.** A `skipped` outcome (breaker open) means
 *    every remaining item would be skipped for the same reason, so the queue
 *    drains instead of hammering Amazon.
 * 4. **A failure is never a collection error.** The row keeps its card values and
 *    the run continues, exactly as a failed enrichment does.
 * 5. **Nothing is written that cannot be trusted.** A payload with no reviews
 *    behind it is discarded (see `isUsableRatingPayload`).
 */
import type { Product } from '../types';
import { backfillProductRating } from '../db/products';
import { parseRatingViaOffscreen } from './offscreen';
import {
  fetchRatingPopover,
  isUsableRatingPayload,
  type RatingFetchOutcome,
} from './rating-fetch';

export interface RatingBackfillDeps {
  /** Injectable for tests; production always uses `fetchRatingPopover`. */
  fetchRating?: typeof fetchRatingPopover;
  parseRating?: typeof parseRatingViaOffscreen;
  write?: typeof backfillProductRating;
}

interface QueuedRating {
  asin: string;
  productUrl: string;
  sessionKey: string;
}

const queue: QueuedRating[] = [];
/** `${sessionKey}::${asin}` — one attempt per product per run. */
const seen = new Set<string>();

let running = false;
let runner: Promise<void> = Promise.resolve();
let fetchImpl: typeof fetchRatingPopover = fetchRatingPopover;
let parseImpl: typeof parseRatingViaOffscreen = parseRatingViaOffscreen;
let writeImpl: typeof backfillProductRating = backfillProductRating;

/**
 * The ticket's trigger, in one predicate: a field the card could not supply.
 * Exported so the handler and the tests agree on the definition instead of each
 * spelling `== null` themselves.
 */
export function needsRatingBackfill(product: {
  rating?: number | null;
  reviewCount?: number | null;
}): boolean {
  return product.rating == null || product.reviewCount == null;
}

/**
 * Queue the products of one batch that the listing could not fully describe.
 *
 * `products` may be the whole batch: the predicate is applied here so no caller
 * can forget it, and a product that already carries both values costs nothing.
 */
export function enqueueRatingBackfill(
  products: readonly {
    asin?: string | null;
    url?: string | null;
    rating?: number | null;
    reviewCount?: number | null;
  }[],
  sessionKey: string,
  deps: RatingBackfillDeps = {},
): void {
  if (!sessionKey) return;
  if (deps.fetchRating) fetchImpl = deps.fetchRating;
  if (deps.parseRating) parseImpl = deps.parseRating;
  if (deps.write) writeImpl = deps.write;

  for (const product of products) {
    if (!product || typeof product !== 'object') continue;
    if (!needsRatingBackfill(product)) continue;

    const asin = typeof product.asin === 'string' ? product.asin : null;
    const productUrl = typeof product.url === 'string' ? product.url : null;
    if (!asin || !productUrl) continue;

    const key = `${sessionKey}::${asin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ asin, productUrl, sessionKey });
  }

  start();
}

/**
 * Called when a run ends, so one run's bookkeeping cannot leak into the next.
 * Queued work is left alone: those rows exist and filling them is still correct.
 */
export function resetRatingBackfill(sessionKey: string): void {
  const prefix = `${sessionKey}::`;
  for (const key of [...seen]) {
    if (key.startsWith(prefix)) seen.delete(key);
  }
}

/** Resolves when the queue has finished draining (tests). */
export function whenRatingBackfillIdle(): Promise<void> {
  return runner;
}

/** How many products this run has queued so far (diagnostics/tests). */
export function ratingBackfillQueuedCount(): number {
  return seen.size;
}

/** Test-only: restore the module to its startup state. */
export function resetRatingBackfillForTests(): void {
  queue.length = 0;
  seen.clear();
  running = false;
  runner = Promise.resolve();
  fetchImpl = fetchRatingPopover;
  parseImpl = parseRatingViaOffscreen;
  writeImpl = backfillProductRating;
}

function start(): void {
  if (running) return;
  running = true;
  runner = run();
}

async function run(): Promise<void> {
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const outcome: RatingFetchOutcome = await fetchImpl(
          item.productUrl,
          item.asin,
        );

        if (outcome.status === 'skipped') {
          // The host is out of service for a minute; every remaining item would
          // be skipped for the same reason.
          queue.length = 0;
          break;
        }
        if (outcome.status !== 'ok') continue;

        const parsed = await parseImpl(outcome.html);
        if (!parsed.ok) continue;

        const values = { rating: parsed.rating, reviewCount: parsed.reviewCount };
        // A non-existent ASIN answers 0.0 / 0; never let that reach a row.
        if (!isUsableRatingPayload(values)) continue;

        await writeImpl(item.sessionKey, item.asin, values);
      } catch {
        // Never a collection error: the row keeps the values the card printed and
        // the run continues with the next product.
      }
    }
  } finally {
    running = false;
  }
}

/** Re-exported so callers do not need a second import for the row type. */
export type RatingBackfillProduct = Pick<Product, 'asin' | 'url' | 'rating' | 'reviewCount'>;
