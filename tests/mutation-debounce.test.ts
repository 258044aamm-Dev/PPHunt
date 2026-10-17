/**
 * Step 5.2 (SAD-178) — H-9b: churn-resistant observer debounce.
 * Proves the debounce that drives the manual-mode MutationObserver:
 * (1) batches bursts exactly like the old trailing-only 300 ms debounce,
 * (2) CANNOT be starved by continuous churn — a mutation every 50 ms still
 *     triggers at least one run within ~2 s (the old implementation runs zero
 *     times in this scenario; a local control proves the failure mode),
 * (3) cancel() drops pending runs (pause/teardown).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChurnResistantDebounce } from '@/lib/scraper/mutation-debounce';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('H-9b: createChurnResistantDebounce', () => {
  it('preserves trailing-debounce batching for a single burst', () => {
    const run = vi.fn();
    const d = createChurnResistantDebounce(run);

    d.notify();
    vi.advanceTimersByTime(100);
    d.notify();
    vi.advanceTimersByTime(100);
    d.notify();

    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a lone mutation runs after the 300 ms window', () => {
    const run = vi.fn();
    const d = createChurnResistantDebounce(run);

    d.notify();
    vi.advanceTimersByTime(299);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('continuous churn every 50 ms for 3 s still runs at least once (starvation fix)', () => {
    const run = vi.fn();
    const d = createChurnResistantDebounce(run);

    for (let t = 0; t < 3000; t += 50) {
      d.notify();
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(300); // let any final trailing run fire

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(1);
    // and the cap means it happened by ~2 s + one debounce window, not "never"
    expect(run.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('control: the OLD trailing-only debounce is starved by the same churn', () => {
    // Local re-implementation of the pre-5.2 observer debounce to demonstrate
    // the exact failure mode this step removes.
    let timer: number | NodeJS.Timeout | null = null;
    const oldRun = vi.fn();
    const oldNotify = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(oldRun, 300);
    };

    for (let t = 0; t < 3000; t += 50) {
      oldNotify();
      vi.advanceTimersByTime(50);
    }
    expect(oldRun).toHaveBeenCalledTimes(0); // starved for the whole 3 s
  });

  it('cancel() drops a pending run and re-arms cleanly', () => {
    const run = vi.fn();
    const d = createChurnResistantDebounce(run);

    d.notify();
    vi.advanceTimersByTime(150);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();

    d.notify();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('after a capped run, the next burst gets a fresh max-wait budget', () => {
    const run = vi.fn();
    const d = createChurnResistantDebounce(run, { maxWaitMs: 500 });

    // starve for 1 s -> capped runs happen along the way
    for (let t = 0; t < 1000; t += 50) {
      d.notify();
      vi.advanceTimersByTime(50);
    }
    const afterChurn = run.mock.calls.length;
    expect(afterChurn).toBeGreaterThanOrEqual(1);

    // a fresh, quiet burst still batches at the full debounce window
    vi.advanceTimersByTime(300);
    run.mockClear();
    d.notify();
    vi.advanceTimersByTime(299);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
