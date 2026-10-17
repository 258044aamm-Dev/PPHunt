/**
 * Mutation debounce that cannot be starved by continuous DOM churn.
 *
 * Phase 5 / H-9b (plan § 5.2): the observer callback previously used a
 * trailing-only 300 ms debounce — every mutation reset the timer, so a
 * continuously mutating Amazon page could postpone collection indefinitely.
 * This keeps the 300 ms batching but caps total wait at `maxWaitMs`: once the
 * first mutation of a burst is older than the cap, the next tick runs
 * immediately. Single bursts still behave exactly like a trailing debounce.
 *
 * Extracted from amazon.content.ts so the timing semantics are unit-testable
 * without a content-script harness.
 */
export interface ChurnResistantDebounceOptions {
  /** Batch window after the last mutation (default 300 ms). */
  debounceMs?: number;
  /** Hard cap since the FIRST mutation of a burst (default 2000 ms). */
  maxWaitMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ChurnResistantDebounce {
  /** Signal a mutation burst; schedules (or reschedules) the run. */
  notify(): void;
  /** Drop any pending run (used on pause / teardown). */
  cancel(): void;
}

export function createChurnResistantDebounce(
  run: () => void,
  options: ChurnResistantDebounceOptions = {}
): ChurnResistantDebounce {
  const { debounceMs = 300, maxWaitMs = 2000, now = () => Date.now() } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstMutationAt = 0;

  return {
    notify(): void {
      const t = now();
      if (!firstMutationAt) firstMutationAt = t;
      if (timer) clearTimeout(timer);
      const delay = Math.min(
        debounceMs,
        Math.max(0, maxWaitMs - (t - firstMutationAt))
      );
      timer = setTimeout(() => {
        timer = null;
        firstMutationAt = 0;
        run();
      }, delay);
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      firstMutationAt = 0;
    },
  };
}
