import type { SaveEnrichmentStatus, SaveJobState } from '../types';

/**
 * SAD-289 (plan 10.4 / R8): the in-memory job table plus its `storage.session`
 * mirror.
 *
 * MV3 can suspend the worker between two `await`s, so a job that only exists in
 * a module-scope `Map` disappears mid-enrichment and the card stays on its
 * spinner forever. This store keeps the same information in
 * `storage.session['pphunt.saveJobs']`, which survives a suspension but not a
 * browser restart - exactly the lifetime a job has.
 *
 * Nothing here writes `storage.local` or IndexedDB: the durable record of a save
 * is the product row, and that is already written before enrichment starts.
 */

export const SAVE_JOB_STORE_KEY = 'pphunt.saveJobs';
/** A job older than this can no longer be usefully resumed. */
export const SAVE_JOB_TTL_MS = 15 * 60 * 1000;
/** One re-run after a restart. A job that dies twice is reported, not retried. */
export const MAX_SAVE_JOB_REQUEUES = 1;
export const SAVE_JOB_MIRROR_DEBOUNCE_MS = 250;

export interface SaveJobRecord {
  jobId: string;
  asin: string;
  productUrl: string;
  sessionKey?: string;
  tabId?: number;
  state: SaveJobState;
  enrichmentStatus?: SaveEnrichmentStatus;
  /** How many times a restart has resumed this job. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionAreaLike {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

function readSessionArea(): SessionAreaLike | null {
  try {
    const g = globalThis as unknown as {
      browser?: { storage?: { session?: SessionAreaLike } };
      chrome?: { storage?: { session?: SessionAreaLike } };
    };
    const area = g.browser?.storage?.session ?? g.chrome?.storage?.session;
    if (
      area &&
      typeof area.get === 'function' &&
      typeof area.set === 'function'
    ) {
      return area;
    }
  } catch {
    // Ignore restricted global access
  }
  return null;
}

export interface JobStoreOptions {
  sessionArea?: SessionAreaLike | null;
  now?: () => number;
  debounceMs?: number;
}

export interface JobStore {
  begin: (input: {
    jobId: string;
    asin: string;
    productUrl: string;
    tabId?: number;
    sessionKey?: string;
  }) => SaveJobRecord;
  update: (
    jobId: string,
    patch: Partial<
      Pick<
        SaveJobRecord,
        'state' | 'enrichmentStatus' | 'sessionKey' | 'attempts'
      >
    >,
  ) => SaveJobRecord | undefined;
  get: (jobId: string) => SaveJobRecord | undefined;
  all: () => SaveJobRecord[];
  /** Reads the mirror back, drops expired rows and returns what could resume. */
  hydrate: () => Promise<{ kept: SaveJobRecord[]; dropped: number }>;
  sweep: () => number;
  flush: () => Promise<void>;
  reset: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeRecord(value: unknown): SaveJobRecord | null {
  if (!isRecord(value)) return null;
  const { jobId, asin, productUrl, state, createdAt, updatedAt } = value;
  if (
    typeof jobId !== 'string' ||
    !jobId ||
    typeof asin !== 'string' ||
    !asin ||
    typeof productUrl !== 'string' ||
    typeof state !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    jobId,
    asin,
    productUrl,
    state: state as SaveJobRecord['state'],
    ...(typeof value.sessionKey === 'string' ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.tabId === 'number' ? { tabId: value.tabId } : {}),
    ...(typeof value.enrichmentStatus === 'string'
      ? { enrichmentStatus: value.enrichmentStatus as SaveEnrichmentStatus }
      : {}),
    attempts: typeof value.attempts === 'number' ? value.attempts : 0,
    createdAt,
    updatedAt,
  };
}

export function createJobStore(options: JobStoreOptions = {}): JobStore {
  const now = options.now ?? (() => Date.now());
  const debounceMs = options.debounceMs ?? SAVE_JOB_MIRROR_DEBOUNCE_MS;
  const area = options.sessionArea === undefined ? readSessionArea() : options.sessionArea;

  const jobs = new Map<string, SaveJobRecord>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const serialize = (): Record<string, unknown>[] =>
    Array.from(jobs.values()).map((record) => ({ ...record }));

  async function writeNow(): Promise<void> {
    pending = false;
    if (!area) return;
    try {
      await area.set({ [SAVE_JOB_STORE_KEY]: serialize() });
    } catch {
      // A lost mirror costs at most one interrupted job; never fail the save.
    }
  }

  function scheduleMirror(): void {
    pending = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, debounceMs);
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) await writeNow();
  }

  function dropExpired(nowMs: number): number {
    let dropped = 0;
    for (const [jobId, record] of jobs) {
      const updatedAt = Date.parse(record.updatedAt);
      if (!Number.isFinite(updatedAt) || nowMs - updatedAt > SAVE_JOB_TTL_MS) {
        jobs.delete(jobId);
        dropped += 1;
      }
    }
    return dropped;
  }

  return {
    begin(input) {
      const timestamp = new Date(now()).toISOString();
      const record: SaveJobRecord = {
        jobId: input.jobId,
        asin: input.asin,
        productUrl: input.productUrl,
        state: 'queued',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      };
      jobs.set(input.jobId, record);
      scheduleMirror();
      return record;
    },

    update(jobId, patch) {
      const existing = jobs.get(jobId);
      if (!existing) return undefined;
      const next: SaveJobRecord = {
        ...existing,
        ...patch,
        updatedAt: new Date(now()).toISOString(),
      };
      jobs.set(jobId, next);

      if (next.state === 'completed' || next.state === 'failed') {
        // Terminal states are mirrored immediately: a suspend right after a
        // save must not resurrect a job that already finished. Finishing a job
        // is also the cheapest moment to evict the ones that timed out.
        dropExpired(now());
        pending = true;
        void flush();
      } else {
        scheduleMirror();
      }

      return next;
    },

    get(jobId) {
      return jobs.get(jobId);
    },

    all() {
      return Array.from(jobs.values());
    },

    async hydrate() {
      if (!area) return { kept: [], dropped: 0 };
      let stored: unknown;
      try {
        const result = await area.get(SAVE_JOB_STORE_KEY);
        stored = result?.[SAVE_JOB_STORE_KEY];
      } catch {
        return { kept: [], dropped: 0 };
      }

      if (!Array.isArray(stored)) return { kept: [], dropped: 0 };

      let dropped = 0;
      const nowMs = now();

      for (const candidate of stored) {
        const record = normalizeRecord(candidate);
        if (!record) {
          dropped += 1;
          continue;
        }
        // In-memory wins: a live job is further along than the mirror.
        if (jobs.has(record.jobId)) continue;

        const updatedAt = Date.parse(record.updatedAt);
        if (!Number.isFinite(updatedAt) || nowMs - updatedAt > SAVE_JOB_TTL_MS) {
          dropped += 1;
          continue;
        }
        jobs.set(record.jobId, record);
      }

      if (dropped > 0) {
        pending = true;
        void flush();
      }

      return { kept: Array.from(jobs.values()), dropped };
    },

    sweep() {
      const dropped = dropExpired(now());
      if (dropped > 0) {
        pending = true;
        void flush();
      }
      return dropped;
    },

    flush,

    reset() {
      jobs.clear();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
    },
  };
}

/** The store the background controller and the recovery step share. */
export const saveJobStore = createJobStore();

/** Terminal-or-not: a job in one of these states can still be resumed. */
export function isResumableState(state: SaveJobState): boolean {
  return state === 'queued' || state === 'extracting' || state === 'enriching';
}

// `types` re-export so callers do not reach into the engine for a status string.
export type { SaveEnrichmentStatus, SaveJobState };
