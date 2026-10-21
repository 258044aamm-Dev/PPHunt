/**
 * SAD-379: the collection pipeline's missing enrichment stage.
 *
 * The save pipeline calls `enrichSavedProduct` once per product (SAD-296); a
 * collection produces many products in batches and ends at `addProducts`, so a
 * collected row only ever carried what the listing card printed — measured as a
 * median of 7 fields against the 19 a save reaches.
 *
 * This pump is the only new machinery: one queue, one serial runner, and one
 * call to the *same* function the save path uses. Nothing about extraction,
 * merging, snapshots or diagnostics is re-implemented here, so a collected row
 * and a saved row cannot drift apart.
 *
 * Design rules (each one is load-bearing):
 *
 * 1. **Never blocks the collection.** `enqueueCollectionEnrichment` returns
 *    immediately and the runner is never awaited by `pendingProductsChain`, so
 *    progress messages and `STOP_COLLECTION` do not wait on a ~2.4 s fetch.
 * 2. **Never twice per run.** A `(sessionKey, asin)` pair is queued once, even
 *    though an `updatedExisting` batch re-sends the whole run.
 * 3. **Deterministic job ids.** `appendSnapshot()` dedupes on
 *    `(asin, jobId, source)`, so a repeated pump cannot invent a second
 *    observation for the same collection.
 * 4. **Bounded.** The caller passes the per-run cap resolved from the setting
 *    (`'25' | '50' | 'all'`).
 * 5. **Stops when the host says stop.** A `skipped` outcome means a guard fired
 *    (no permission, breaker open); every remaining item would be skipped for
 *    the same reason, so the queue drains instead of hammering Amazon.
 * 6. **A failure is never a collection error.** The row keeps its card data and
 *    the run continues, exactly as a failed save does.
 *
 * Known limitation (documented in the ticket): the queue is in-memory, so an
 * MV3 worker suspension mid-run loses the remaining tail. Rows are untouched;
 * the `job-store` + `save-job-recovery` pattern remains the upgrade path.
 */
import { enrichSavedProduct } from './enrich-saved-product';

export interface EnrichmentPumpDeps {
  /** Injectable for tests; production always uses `enrichSavedProduct`. */
  enrich?: typeof enrichSavedProduct;
  /** Per-run cap. `Number.POSITIVE_INFINITY` means "the whole run". */
  limit?: number;
}

interface QueuedEnrichment {
  asin: string;
  productUrl: string;
  sessionKey: string;
}

const queue: QueuedEnrichment[] = [];
/** `${sessionKey}::${asin}` — one attempt per product per run. */
const seen = new Set<string>();
/** sessionKey → how many products this run has already queued. */
const counts = new Map<string, number>();

let running = false;
let runner: Promise<void> = Promise.resolve();
let enrichImpl: typeof enrichSavedProduct = enrichSavedProduct;

/**
 * Deterministic so `appendSnapshot()`'s `(asin, jobId, source)` dedupe applies:
 * a replayed pump writes no second detail snapshot for the same collection.
 */
export function collectionEnrichmentJobId(
  sessionKey: string,
  asin: string,
): string {
  return `collect:${sessionKey}:${asin}`;
}

/**
 * Queues the newly collected products of one batch. Safe to call with products
 * that were already queued (they are skipped) and with products that have no
 * ASIN or URL (they cannot be enriched and are ignored).
 */
export function enqueueCollectionEnrichment(
  products: readonly { asin?: string | null; url?: string | null }[],
  sessionKey: string,
  deps: EnrichmentPumpDeps = {},
): void {
  if (deps.enrich) {
    enrichImpl = deps.enrich;
  }
  const limit = deps.limit ?? Number.POSITIVE_INFINITY;

  for (const product of products) {
    const asin = product.asin;
    const productUrl = product.url;
    if (!asin || !productUrl) continue;

    const key = `${sessionKey}::${asin}`;
    if (seen.has(key)) continue;

    const used = counts.get(sessionKey) ?? 0;
    if (used >= limit) break;

    seen.add(key);
    counts.set(sessionKey, used + 1);
    queue.push({ asin, productUrl, sessionKey });
  }

  void start();
}

/**
 * Called when a run ends, so a finished run's bookkeeping cannot leak into the
 * next one. Queued work is intentionally left alone: those rows already exist
 * and enriching them is still correct.
 */
export function resetCollectionEnrichment(sessionKey: string): void {
  counts.delete(sessionKey);
  const prefix = `${sessionKey}::`;
  for (const key of [...seen]) {
    if (key.startsWith(prefix)) seen.delete(key);
  }
}

/** How many products this run has queued so far (diagnostics/tests). */
export function collectionEnrichmentQueuedCount(sessionKey: string): number {
  return counts.get(sessionKey) ?? 0;
}

/** Resolves when the current run of the queue has finished (tests). */
export function whenCollectionEnrichmentIdle(): Promise<void> {
  return runner;
}

/** Test-only: restore the module to its startup state. */
export function resetCollectionEnrichmentForTests(): void {
  queue.length = 0;
  seen.clear();
  counts.clear();
  running = false;
  runner = Promise.resolve();
  enrichImpl = enrichSavedProduct;
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
        const result = await enrichImpl({
          jobId: collectionEnrichmentJobId(item.sessionKey, item.asin),
          asin: item.asin,
          productUrl: item.productUrl,
          sessionKey: item.sessionKey,
        });
        if (result.status === 'skipped') {
          // The host is out of service for a minute; every remaining item would
          // be skipped for the same reason.
          queue.length = 0;
          break;
        }
      } catch {
        // Never a collection error — the row keeps card quality and the run
        // continues with the next product.
      }
    }
  } finally {
    running = false;
  }
}
