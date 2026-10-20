import { TEMU_DIAGNOSTICS_LEDGER_KEY } from '../constants/defaults';
import type { TemuDiagnosticsReport } from '../schemas/messages';

/**
 * SAD-360 (decision A2): at most one diagnostic line per
 * (sessionId, goodsId, stage), with suppression surviving a normal
 * service-worker restart.
 *
 * Two layers:
 *  - an in-memory Set, which answers every call in the common case;
 *  - `browser.storage.session`, which survives worker suspension.
 *
 * Fail-open (owner decision, 2026-10-20): if the storage read or write fails we
 * still log. A rare duplicate line is preferable to silently losing diagnostics,
 * and this module never touches persistence.
 */
const MAX_LEDGER_KEYS = 20_000;

const seenInMemory = new Set<string>();

interface StorageAreaLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function ledgerArea(): StorageAreaLike | null {
  try {
    const g = globalThis as unknown as {
      browser?: { storage?: { session?: StorageAreaLike } };
      chrome?: { storage?: { session?: StorageAreaLike } };
    };
    const area = g.browser?.storage?.session ?? g.chrome?.storage?.session;
    return area && typeof area.get === 'function' ? area : null;
  } catch {
    return null;
  }
}

export function diagnosticLedgerKey(
  sessionId: string | null,
  goodsId: string | null,
  stage: TemuDiagnosticsReport['stage']
): string {
  return `${sessionId ?? 'no-session'}|${goodsId ?? 'no-goods-id'}|${stage}`;
}

/**
 * Returns true when this report has not been logged yet, and records it.
 * Fails open: a storage fault yields `true`.
 */
export async function claimDiagnosticLine(
  key: string
): Promise<boolean> {
  if (seenInMemory.has(key)) return false;
  seenInMemory.add(key);

  const area = ledgerArea();
  if (!area) return true;
  try {
    const stored = await area.get(TEMU_DIAGNOSTICS_LEDGER_KEY);
    const existing = stored[TEMU_DIAGNOSTICS_LEDGER_KEY];
    const record =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, number>)
        : {};
    if (record[key]) return false;

    record[key] = Date.now();
    const keys = Object.keys(record);
    if (keys.length > MAX_LEDGER_KEYS) {
      // Insertion order is preserved, so the oldest entries go first.
      const trimmed: Record<string, number> = {};
      for (const k of keys.slice(keys.length - MAX_LEDGER_KEYS)) {
        trimmed[k] = record[k]!;
      }
      await area.set({ [TEMU_DIAGNOSTICS_LEDGER_KEY]: trimmed });
    } else {
      await area.set({ [TEMU_DIAGNOSTICS_LEDGER_KEY]: record });
    }
  } catch {
    // Fail open by owner decision: logging is best-effort, saving is not.
  }
  return true;
}

/** Test seam: forget the in-memory layer (the storage layer is untouched). */
export function resetDiagnosticLedgerMemory(): void {
  seenInMemory.clear();
}
