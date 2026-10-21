/** Serial collection queue. Full detail enrichment is capped; missing brand/BSR
 * fallback is independent of that budget. Uses the save fetch/parser/limiter.
 * Metadata is mirrored to storage.session before dispatch, not HTML or products.
 */
import { z } from 'zod';
import { enrichSavedProduct } from './enrich-saved-product';
import { CIRCUIT_COOLDOWN_MS } from './enrichment-fetch';

export const COLLECTION_ENRICHMENT_KEY = 'pphunt.collectionEnrichment';
export const COLLECTION_ENRICHMENT_ALARM = 'pphunt.collectionEnrichment.resume';
export const COLLECTION_ENRICHMENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 2;

const JobSchema = z.object({
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
  productUrl: z.url(),
  sessionKey: z.string().min(1),
  scope: z.enum(['full', 'brand-and-rank']).optional(),
  state: z.enum(['queued', 'in-flight', 'done']),
  attempts: z.number().int().min(0).max(MAX_ATTEMPTS),
  createdAt: z.number().finite(),
  notBefore: z.number().finite(),
});
type Job = z.infer<typeof JobSchema>;
type ProductHint = { asin?: string | null; url?: string | null; brand?: string | null; bestSellersRank?: string | null };

export interface EnrichmentPumpDeps {
  enrich?: typeof enrichSavedProduct;
  /** Full-detail budget only. Zero disables full enrichment. */
  limit?: number;
  requiredFields?: boolean;
}

interface PumpBrowser {
  storage?: { session?: {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  } };
  alarms?: { create: (name: string, info: { when: number }) => unknown };
}
function api(): PumpBrowser | undefined {
  const globals = globalThis as { browser?: PumpBrowser; chrome?: PumpBrowser };
  return globals.browser ?? globals.chrome;
}

const queue: Job[] = [];
const records = new Map<string, Job>();
const seen = new Set<string>();
const counts = new Map<string, number>();
let running = false;
let runner: Promise<void> = Promise.resolve();
let writes: Promise<void> = Promise.resolve();
let initialized: Promise<void> | undefined;
let durable = false;
let generation = 0;
let enrichImpl: typeof enrichSavedProduct = enrichSavedProduct;
const keyOf = (item: Pick<Job, 'sessionKey' | 'asin'>) => `${item.sessionKey}::${item.asin}`;

export function collectionEnrichmentJobId(sessionKey: string, asin: string): string {
  return `collect:${sessionKey}:${asin}`;
}

function warnStorage(): void {
  console.warn('[PPHunt] Collection enrichment recovery storage unavailable; rows remain saved.');
}

/** Serialized snapshots: a stale write must not overwrite newer queue state. */
function persist(): Promise<void> {
  if (!durable) return Promise.resolve();
  const snapshot = [...records.values()].map(job => ({ ...job }));
  writes = writes.then(async () => {
    try { await api()?.storage?.session?.set({ [COLLECTION_ENRICHMENT_KEY]: snapshot }); }
    catch { warnStorage(); }
  });
  return writes;
}

function prune(): void {
  const cutoff = Date.now() - COLLECTION_ENRICHMENT_TTL_MS;
  for (const [key, job] of records) {
    if (job.createdAt < cutoff && job.state === 'done') {
      records.delete(key);
      seen.delete(key);
    }
  }
  counts.clear();
  for (const job of records.values()) {
    if (job.scope !== 'brand-and-rank') counts.set(job.sessionKey, (counts.get(job.sessionKey) ?? 0) + 1);
  }
}

async function initialize(): Promise<void> {
  durable = true;
  initialized ??= (async () => {
    try {
      const raw = (await api()?.storage?.session?.get(COLLECTION_ENRICHMENT_KEY))?.[COLLECTION_ENRICHMENT_KEY];
      if (Array.isArray(raw)) for (const value of raw) {
        const parsed = JobSchema.safeParse(value);
        if (!parsed.success) continue;
        const job = parsed.data;
        const key = keyOf(job);
        if (seen.has(key)) continue;
        if (job.createdAt < Date.now() - COLLECTION_ENRICHMENT_TTL_MS || job.attempts >= MAX_ATTEMPTS) job.state = 'done';
        records.set(key, job);
        seen.add(key);
        if (job.state !== 'done') queue.push(job);
      }
      prune();
    } catch { warnStorage(); }
  })();
  await initialized;
}

/** Production entry: recover bookkeeping before accepting new batches. Does not
 * await the network runner, so STOP/progress are independent of fetch duration. */
export async function scheduleCollectionEnrichment(
  products: readonly ProductHint[], sessionKey: string, deps: EnrichmentPumpDeps,
): Promise<void> {
  await initialize();
  prune();
  enqueueCollectionEnrichment(products, sessionKey, deps);
  await persist();
}

/** Called on worker boot and the named cooldown alarm. */
export async function recoverCollectionEnrichment(): Promise<void> {
  await initialize();
  start();
}

/** Synchronous seam for queue tests. Production uses scheduleCollectionEnrichment. */
export function enqueueCollectionEnrichment(
  products: readonly ProductHint[], sessionKey: string, deps: EnrichmentPumpDeps = {},
): void {
  if (deps.enrich) enrichImpl = deps.enrich;
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
    // Complete rows need no fallback. Do not consume a full-detail budget slot.
    if (!full && (!deps.requiredFields || !missing)) continue;
    seen.add(key);
    if (full) counts.set(sessionKey, used + 1);
    const job: Job = {
      asin, productUrl, sessionKey,
      ...(!full ? { scope: 'brand-and-rank' as const } : {}),
      state: 'queued', attempts: 0, createdAt: Date.now(), notBefore: 0,
    };
    records.set(key, job);
    queue.push(job);
  }
  start();
}

/** Explicit reset seam; production retains bookkeeping through STOP/resume and
 * prunes terminal records after 24h instead of clearing on completion. */
export function resetCollectionEnrichment(sessionKey: string): void {
  counts.delete(sessionKey);
  for (const key of [...seen]) if (key.startsWith(`${sessionKey}::`)) {
    seen.delete(key);
    records.delete(key);
  }
}
export function collectionEnrichmentQueuedCount(sessionKey: string): number {
  return counts.get(sessionKey) ?? 0;
}
/** Resolves after currently eligible work; cooldown-deferred items remain pending. */
export function whenCollectionEnrichmentIdle(): Promise<void> { return runner; }
export function resetCollectionEnrichmentForTests(): void {
  generation++;
  queue.length = 0;
  seen.clear(); records.clear(); counts.clear();
  running = false; durable = false; initialized = undefined;
  runner = Promise.resolve(); writes = Promise.resolve();
  enrichImpl = enrichSavedProduct;
}

function start(): void {
  if (running) return;
  running = true;
  runner = run(generation);
}

function wakeAt(when: number): void {
  try {
    const result = api()?.alarms?.create(COLLECTION_ENRICHMENT_ALARM, { when });
    void Promise.resolve(result).catch(() => {});
  } catch { /* A later worker event can still recover pending records. */ }
}

async function run(epoch: number): Promise<void> {
  try {
    while (queue.length > 0 && epoch === generation) {
      const index = queue.findIndex(job => job.notBefore <= Date.now());
      if (index < 0) {
        wakeAt(Math.min(...queue.map(job => job.notBefore)));
        break;
      }
      const item = queue.splice(index, 1)[0]!;
      item.state = 'in-flight';
      item.attempts++;
      // Persist ALL pending jobs before starting this request. A suspension
      // between any two awaits leaves recoverable metadata, not a lost tail.
      await persist();
      if (epoch !== generation) return;
      try {
        const result = await enrichImpl({
          ...(item.scope ? { scope: item.scope } : {}),
          jobId: collectionEnrichmentJobId(item.sessionKey, item.asin),
          asin: item.asin, productUrl: item.productUrl, sessionKey: item.sessionKey,
        });
        if (epoch !== generation) return;
        if (result.skipReason === 'circuit-open' && item.attempts < MAX_ATTEMPTS) {
          item.notBefore = Date.now() + CIRCUIT_COOLDOWN_MS;
          item.state = 'queued';
          queue.push(item);
          // Defer only this host; unrelated marketplaces continue now.
          const host = new URL(item.productUrl).host;
          for (const job of queue) if (new URL(job.productUrl).host === host) {
            job.notBefore = Math.max(job.notBefore, item.notBefore);
          }
        } else item.state = 'done';
      } catch {
        if (epoch !== generation) return;
        item.state = 'done'; // Never turn a failed enrichment into a collection error.
      }
      await persist();
    }
  } finally {
    if (epoch === generation) running = false;
  }
}
