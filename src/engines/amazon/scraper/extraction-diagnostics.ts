import type { AmazonExtractionTier, ScrapedAmazonProduct } from '../types';

/**
 * SAD-359: per-field extraction diagnostics for the Amazon engine.
 *
 * The parsers already *decide* everything this module records — which
 * selector produced a value, whether a candidate node existed but its text
 * could not be parsed, whether JSON-LD had to rescue a failed DOM candidate,
 * whether validation later dropped the value — and then throw the decision
 * away. A collector is threaded through the detail parser as an optional
 * out-parameter so those decisions become one structured report per product.
 *
 * Diagnostics only: nothing here feeds back into extraction, enrichment
 * status, or stored data. The module is deliberately DOM-free so the
 * classification rules are unit-testable without a page fixture.
 */

export type FieldExtractionStatus = 'EXTRACTED' | 'MISSING' | 'PARTIAL';

export type FieldExtractionSource =
  | 'dom'
  | 'json-ld'
  | 'legacy'
  | 'derived'
  | 'url';

export interface FieldDiagnostic {
  field: string;
  status: FieldExtractionStatus;
  /** Where the value (or the surviving fallback value) came from. */
  source?: FieldExtractionSource;
  /** Winning CSS selector, or the rejected candidate's selector for PARTIAL. */
  selector?: string;
  /** Card/buybox extraction tier when the shared pricing cascade provided it. */
  tier?: AmazonExtractionTier;
  /** Why the field is MISSING or PARTIAL (absent vs unparseable vs invalid). */
  reason?: string;
  /** Whether the value survived `validateAndNormalizeScrapedProduct`. */
  validated?: boolean;
}

export interface ExtractionDiagnosticsReport {
  asin: string | null;
  fields: FieldDiagnostic[];
}

/**
 * Fields the PDP detail parser can extract, in parser order.
 *
 * `badge` is deliberately absent: the detail stage never extracts it (it is a
 * listing-card field), so listing it here would print a permanent, meaningless
 * MISSING. `warrantyDescriptionRaw` travels with `warrantyDescription` and is
 * covered by that entry.
 */
export const DETAIL_DIAGNOSTIC_FIELDS: readonly string[] = [
  'asin',
  'title',
  'brand',
  'price',
  'listPrice',
  'discountPercentage',
  'dealBadge',
  'coupon',
  'currency',
  'pastMonthSales',
  'rating',
  'reviewCount',
  'availability',
  'delivery',
  'seller',
  'features',
  'description',
  'imageUrl',
  'bestSellersRank',
  'warrantyDescription',
  'variations',
  'weight',
  'isPrime',
];

interface RecordOptions {
  source?: FieldExtractionSource;
  selector?: string;
  tier?: AmazonExtractionTier;
  reason?: string;
}

export interface FieldDiagnosticsCollector {
  /** Records the ASIN the parse resolved to, for the report envelope. */
  setAsin(asin: string | null): void;
  extracted(field: string, options?: RecordOptions): void;
  missing(field: string, reason: string, options?: RecordOptions): void;
  partial(field: string, reason: string, options?: RecordOptions): void;
  /**
   * SAD-359 (strict rescue rule): a DOM candidate was found but rejected, and
   * a fallback source supplied the value. The value survived, but the field
   * is PARTIAL so DOM selector rot stays visible instead of hiding behind
   * the fallback.
   */
  rescued(field: string, reason: string, options?: RecordOptions): void;
  /**
   * Builds the report. Fields never recorded (e.g. the parser aborted on a
   * missing title) are reported as MISSING with reason 'not attempted', so a
   * report always covers the whole field set honestly.
   */
  build(fields?: readonly string[]): ExtractionDiagnosticsReport;
  /** Internal view used by `applyValidationResults`. */
  entries(): Map<string, FieldDiagnostic>;
}

export function createFieldDiagnosticsCollector(): FieldDiagnosticsCollector {
  const byField = new Map<string, FieldDiagnostic>();
  let asin: string | null = null;

  const record = (entry: FieldDiagnostic) => {
    // Last write wins: the parser records a field once its outcome is final,
    // and validation may later override that outcome.
    byField.set(entry.field, entry);
  };

  const withOptions = (
    base: FieldDiagnostic,
    options?: RecordOptions,
  ): FieldDiagnostic => ({
    ...base,
    ...(options?.source ? { source: options.source } : {}),
    ...(options?.selector ? { selector: options.selector } : {}),
    ...(options?.tier ? { tier: options.tier } : {}),
    ...(options?.reason ? { reason: options.reason } : {}),
  });

  return {
    setAsin(value) {
      asin = value;
    },
    extracted(field, options) {
      record(withOptions({ field, status: 'EXTRACTED' }, options));
    },
    missing(field, reason, options) {
      record(withOptions({ field, status: 'MISSING', reason }, options));
    },
    partial(field, reason, options) {
      record(withOptions({ field, status: 'PARTIAL', reason }, options));
    },
    rescued(field, reason, options) {
      record(withOptions({ field, status: 'PARTIAL', reason }, options));
    },
    build(fields = DETAIL_DIAGNOSTIC_FIELDS) {
      return {
        asin,
        fields: fields.map(
          (field) =>
            byField.get(field) ?? {
              field,
              status: 'MISSING' as const,
              reason: 'not attempted',
            },
        ),
      };
    },
    entries() {
      return byField;
    },
  };
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Reconciles recorded outcomes with `validateAndNormalizeScrapedProduct`:
 *
 * - candidate had a value, normalized product kept it → `validated: true`
 * - candidate had a value, validation dropped/nulled it → the entry becomes
 *   PARTIAL, `validated: false`, reason 'parsed but failed validation'
 * - whole product rejected (`normalized === null`) → entries are left as
 *   recorded; validation never passed, so no `validated` flag is invented.
 *
 * `isPrime` is excluded: `false` is a legitimate normalized value, not an
 * absence, so emptiness comparison does not apply to it.
 */
export function applyValidationResults(
  collector: FieldDiagnosticsCollector,
  candidate: Partial<ScrapedAmazonProduct>,
  normalized: ScrapedAmazonProduct | null,
): void {
  if (!normalized) return;

  const entries = collector.entries();
  const raw = candidate as Record<string, unknown>;
  const kept = normalized as unknown as Record<string, unknown>;

  for (const field of DETAIL_DIAGNOSTIC_FIELDS) {
    if (field === 'isPrime') continue;
    if (isEmptyValue(raw[field])) continue;

    const entry = entries.get(field);
    if (!entry) continue;

    if (isEmptyValue(kept[field])) {
      entries.set(field, {
        ...entry,
        status: 'PARTIAL',
        reason: 'parsed but failed validation',
        validated: false,
      });
    } else if (entry.status !== 'MISSING') {
      entries.set(field, { ...entry, validated: true });
    }
  }
}

export interface FieldDiagnosticCounts {
  extracted: number;
  missing: number;
  partial: number;
}

export function summarizeFieldDiagnostics(
  fields: readonly FieldDiagnostic[],
): FieldDiagnosticCounts {
  const counts: FieldDiagnosticCounts = { extracted: 0, missing: 0, partial: 0 };
  for (const entry of fields) {
    if (entry.status === 'EXTRACTED') counts.extracted += 1;
    else if (entry.status === 'PARTIAL') counts.partial += 1;
    else counts.missing += 1;
  }
  return counts;
}

/**
 * The exact one-line console form used by both service-worker log sites.
 *
 * One-line `JSON.stringify` is deliberate (the SAD-352 step 1a.1 lesson):
 * console objects collapse to `…` when pasted out of DevTools, single-line
 * JSON survives copy-paste and stays greppable. Values themselves (titles,
 * prices) are never logged — statuses, selectors, reasons and counts only.
 */
export function formatExtractionDiagnosticsLog(
  report: ExtractionDiagnosticsReport,
  context: { asin: string; stage: string; jobId?: string },
): string {
  const payload = {
    ...(context.jobId ? { jobId: context.jobId } : {}),
    asin: context.asin,
    stage: context.stage,
    counts: summarizeFieldDiagnostics(report.fields),
    fields: report.fields,
  };
  return `[PPHunt] extraction diagnostics ${JSON.stringify(payload)}`;
}
