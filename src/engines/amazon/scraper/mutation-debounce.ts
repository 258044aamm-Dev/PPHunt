export interface ChurnResistantDebounceOptions {
  debounceMs?: number;
  maxWaitMs?: number;
}

export interface ChurnResistantDebounce {
  notify: () => void;
  cancel: () => void;
}

/**
 * Creates a trailing debounce with a starvation-proof `maxWaitMs` ceiling.
 * Batches rapid DOM mutations at `debounceMs` (default 300ms) while guaranteeing
 * execution at least once every `maxWaitMs` (default 2000ms) under continuous DOM churn.
 */
export function createChurnResistantDebounce(
  callback: () => void,
  options: ChurnResistantDebounceOptions = {},
): ChurnResistantDebounce {
  const debounceMs = options.debounceMs ?? 300;
  const maxWaitMs = options.maxWaitMs ?? 2000;

  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  const invoke = () => {
    clearTimers();
    callback();
  };

  return {
    notify() {
      if (trailingTimer !== null) {
        clearTimeout(trailingTimer);
      }
      trailingTimer = setTimeout(invoke, debounceMs);

      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(invoke, maxWaitMs);
      }
    },
    cancel() {
      clearTimers();
    },
  };
}
