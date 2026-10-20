/**
 * SAD-369 step 3 (E12/E13, D7/D11): the per-run collection diagnostics state.
 *
 * The rules, in plain words:
 * - the FIRST 50 unique products of a collection run each print one line
 *   (`COLLECTION_DIAGNOSTICS_LIMIT`, D7); from the 51st on, the run prints
 *   nothing more;
 * - the counter counts unique products with a report — duplicates and
 *   re-parses of the same card never burn cap slots;
 * - every report is sent to the worker exactly ONCE per run, even though an
 *   `updatedExisting` batch re-sends the entire run's products (D11 — the
 *   reports are a self-identified subset, never a parallel array);
 * - the run boundary is a new collection: `reset()` clears everything.
 *
 * Lives in its own module (rather than closures inside `main()`) so these
 * invariants are directly unit-testable.
 */
import { COLLECTION_DIAGNOSTICS_LIMIT } from '../constants/defaults';
import type {
  ExtractionDiagnosticsReport,
  ExtractionDiagnosticsSink,
} from '../scraper/extraction-diagnostics';
import { normalizeASIN } from '../utils/amazon-url';

export interface CollectionDiagnosticsRun {
  /** Hand this to the listing parsers (or the detail collector) for the run. */
  sink: ExtractionDiagnosticsSink;
  /**
   * Returns the reports for `products` that have not been sent yet this run
   * (in batch order), marking them sent. Products without a report (past the
   * cap, or parsed while the switch was off) are skipped.
   */
  takeUnsentFor(
    products: readonly { asin?: string | null }[],
  ): ExtractionDiagnosticsReport[];
  /** Unique products logged so far this run (the D7 counter). */
  loggedCount(): number;
  /** A new collection starts: clear the counter and both maps (T26). */
  reset(): void;
}

export function createCollectionDiagnosticsRun(): CollectionDiagnosticsRun {
  /** asin → the first accepted report for that product this run. */
  const runReports = new Map<string, ExtractionDiagnosticsReport>();
  /** Reports already handed to a PRODUCTS_COLLECTED message this run. */
  const sentAsins = new Set<string>();
  let loggedThisRun = 0;

  // One key function for both sides, so sink keys and product lookups can
  // never drift on case or format.
  const keyOf = (asin: string | null | undefined): string | null => {
    if (!asin) return null;
    return normalizeASIN(asin) ?? asin.toUpperCase();
  };

  return {
    sink: {
      accept(report: ExtractionDiagnosticsReport): void {
        const key = keyOf(report.asin);
        if (!key || runReports.has(key)) return; // one report per product; re-parses ignored
        if (loggedThisRun >= COLLECTION_DIAGNOSTICS_LIMIT) return; // D7
        loggedThisRun += 1;
        runReports.set(key, report);
      },
    },
    takeUnsentFor(products) {
      const out: ExtractionDiagnosticsReport[] = [];
      for (const product of products) {
        const key = keyOf(product.asin);
        if (!key || sentAsins.has(key)) continue;
        const report = runReports.get(key);
        if (!report) continue; // past the cap, or parsed without a report
        out.push(report);
        sentAsins.add(key); // once per product per run (D11)
      }
      return out;
    },
    loggedCount() {
      return loggedThisRun;
    },
    reset() {
      runReports.clear();
      sentAsins.clear();
      loggedThisRun = 0;
    },
  };
}
