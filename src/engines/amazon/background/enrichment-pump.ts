/** Serial collection queue. Full detail enrichment is capped; missing brand/BSR
 * fallback is independent of that budget. Uses the save fetch/parser/limiter. */
import { enrichSavedProduct, type EnrichmentScope } from './enrich-saved-product';

export interface EnrichmentPumpDeps {
  /** Injectable for tests; production always uses `enrichSavedProduct`. */
  enrich?: typeof enrichSavedProduct;
  /** Per-run cap. `Number.POSITIVE_INFINITY` means "the whole run". */
  limit?: number;
  /** Enable missing brand/BSR fallback beyond the full-detail budget. */
  requiredFields?: boolean;
}

interface QueuedEnrichment {
  scope?: EnrichmentScope;
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
  products: readonly { asin?: string | null; url?: string | null; brand?: string | null; bestSellersRank?: string | null }[],
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
    const full = used < limit;
    const missing = [product.brand, product.bestSellersRank].some(
      value => typeof value !== 'string' || value.trim().length === 0,
    );
    seen.add(key);
    if (!full && (!deps.requiredFields || !missing)) continue;
    if (full) counts.set(sessionKey, used + 1);
    queue.push({ asin, productUrl, sessionKey,
      ...(!full ? { scope: 'brand-and-rank' as const } : {}),
    });
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
          ...(item.scope ? { scope: item.scope } : {}),
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
