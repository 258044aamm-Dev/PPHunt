import type { TemuPageType, TemuScrapedProduct } from '../types';

/**
 * SAD-360: Temu-only extraction evidence, never product data.
 * DOM-free and side-effect-free: callers record decisions they already made.
 * Parser instrumentation, transport, and console emission are separate steps.
 */
export const DETAIL_DIAGNOSTIC_FIELDS = Object.freeze([
  'url',
  'title',
  'price',
  'listPrice',
  'discountPercentage',
  'currency',
  'rating',
  'reviewCount',
  'pastMonthSales',
  'imageUrl',
  'brand',
  'seller',
  'availability',
  'dealBadge',
  'badge',
  'coupon',
  'delivery',
  'bestSellersRank',
  'description',
  'features',
  'isSponsored',
  'isPrime',
] as const satisfies readonly (keyof TemuScrapedProduct)[]);

export type TemuDiagnosticField = (typeof DETAIL_DIAGNOSTIC_FIELDS)[number];
export type TemuDiagnosticStage = Exclude<TemuPageType, 'unknown'>;

export const CARD_DIAGNOSTIC_FIELDS = Object.freeze(
  DETAIL_DIAGNOSTIC_FIELDS.filter(
    (field) => field !== 'description' && field !== 'features'
  )
);

export type FieldExtractionStatus =
  | 'EXTRACTED'
  | 'MISSING'
  | 'PARSE_FAILED'
  | 'PARTIAL'
  | 'UNKNOWN';

export type FieldExtractionSource = 'dom' | 'json-ld' | 'url' | 'derived';

export interface FieldDiagnostic {
  field: TemuDiagnosticField;
  status: FieldExtractionStatus;
  source?: FieldExtractionSource;
  selector?: string;
  /** Static explanation only; never interpolate an extracted value or HTML. */
  reason?: string;
  /** Existing parse-time validation, not a claim that persistence ran. */
  validated?: boolean;
}

export interface ExtractionDiagnosticsReport {
  goodsId: string | null;
  stage: TemuDiagnosticStage;
  fields: FieldDiagnostic[];
}

interface RecordOptions {
  source?: FieldExtractionSource;
  selector?: string;
  reason?: string;
}

export interface FieldDiagnosticsCollector {
  setGoodsId(goodsId: string | null): void;
  extracted(field: TemuDiagnosticField, options?: RecordOptions): void;
  missing(field: TemuDiagnosticField, reason: string, options?: RecordOptions): void;
  parseFailed(field: TemuDiagnosticField, reason: string, options?: RecordOptions): void;
  partial(field: TemuDiagnosticField, reason: string, options?: RecordOptions): void;
  rescued(field: TemuDiagnosticField, reason: string, options?: RecordOptions): void;
  unknown(field: TemuDiagnosticField, reason: string, options?: RecordOptions): void;
  /** A fresh snapshot of the fixed stage-specific field set. */
  build(): ExtractionDiagnosticsReport;
  /** Internal reconciliation view; product objects never enter this map. */
  entries(): Map<TemuDiagnosticField, FieldDiagnostic>;
}

export function createFieldDiagnosticsCollector(
  stage: TemuDiagnosticStage = 'product_detail'
): FieldDiagnosticsCollector {
  const fields: readonly TemuDiagnosticField[] =
    stage === 'product_detail' ? DETAIL_DIAGNOSTIC_FIELDS : CARD_DIAGNOSTIC_FIELDS;
  const byField = new Map<TemuDiagnosticField, FieldDiagnostic>();
  let goodsId: string | null = null;

  const record = (
    field: TemuDiagnosticField,
    status: FieldExtractionStatus,
    options?: RecordOptions,
    reason?: string
  ): void => {
    try {
      if (!fields.includes(field)) return;
      const source = options?.source;
      const selector = options?.selector;
      const explanation = reason ?? options?.reason;
      // Whitelist metadata instead of spreading options that could contain values.
      byField.set(field, {
        field,
        status,
        ...(source ? { source } : {}),
        ...(selector ? { selector } : {}),
        ...(explanation ? { reason: explanation } : {}),
      });
    } catch {
      // Diagnostic failures must not escape into extraction.
    }
  };

  return {
    setGoodsId(value) {
      goodsId = value;
    },
    extracted(field, options) {
      record(field, 'EXTRACTED', options);
    },
    missing(field, reason, options) {
      record(field, 'MISSING', options, reason);
    },
    parseFailed(field, reason, options) {
      record(field, 'PARSE_FAILED', options, reason);
    },
    partial(field, reason, options) {
      record(field, 'PARTIAL', options, reason);
    },
    rescued(field, reason, options) {
      record(field, 'PARTIAL', options, reason);
    },
    unknown(field, reason, options) {
      record(field, 'UNKNOWN', options, reason);
    },
    build() {
      return {
        goodsId,
        stage,
        fields: fields.map((field) => {
          const entry = byField.get(field);
          return entry
            ? { ...entry }
            : { field, status: 'UNKNOWN', reason: 'not attempted' };
        }),
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
 * Reconcile only obtained values against the existing validator's result.
 * A dropped value becomes PARTIAL/validated:false; a rescue stays PARTIAL.
 * False and zero are legitimate values, not validation failures. Unattempted,
 * missing, and unparseable fields get no invented validation result.
 */
export function applyValidationResults(
  collector: FieldDiagnosticsCollector,
  candidate: Partial<TemuScrapedProduct>,
  normalized: TemuScrapedProduct | null
): void {
  if (!normalized) return;
  try {
    const entries = collector.entries();
    for (const [field, entry] of entries) {
      if (entry.status !== 'EXTRACTED' && entry.status !== 'PARTIAL') continue;
      if (isEmptyValue(candidate[field])) continue;
      const validated = !isEmptyValue(normalized[field]);
      entries.set(field, {
        ...entry,
        ...(!validated
          ? { status: 'PARTIAL', reason: 'parsed but failed validation' }
          : {}),
        validated,
      });
    }
  } catch {
    // Reconciliation is observational and must never affect validation/saving.
  }
}

export interface FieldDiagnosticCounts {
  extracted: number;
  missing: number;
  parseFailed: number;
  partial: number;
  unknown: number;
}

export function summarizeFieldDiagnostics(
  fields: readonly FieldDiagnostic[]
): FieldDiagnosticCounts {
  const counts: FieldDiagnosticCounts = {
    extracted: 0,
    missing: 0,
    parseFailed: 0,
    partial: 0,
    unknown: 0,
  };
  for (const entry of fields) {
    if (entry.status === 'EXTRACTED') counts.extracted++;
    else if (entry.status === 'MISSING') counts.missing++;
    else if (entry.status === 'PARSE_FAILED') counts.parseFailed++;
    else if (entry.status === 'PARTIAL') counts.partial++;
    else counts.unknown++;
  }
  return counts;
}

/** Return a paste-safe line, or null if formatting fails. Never emit a log here. */
export function formatTemuExtractionDiagnosticsLog(
  report: ExtractionDiagnosticsReport,
  context: { sessionId?: string | null; pageType?: TemuPageType } = {}
): string | null {
  try {
    const fields = report.fields.map((entry) => ({
      field: entry.field,
      status: entry.status,
      source: entry.source,
      selector: entry.selector,
      reason: entry.reason,
      validated: entry.validated,
    }));
    return `[PPHunt][Temu][Diagnostics] ${JSON.stringify({
      goodsId: report.goodsId,
      sessionId: context.sessionId ?? null,
      stage: report.stage,
      ...(context.pageType ? { pageType: context.pageType } : {}),
      counts: summarizeFieldDiagnostics(fields),
      fields,
    })}`;
  } catch {
    // A future service-worker caller can safely skip this line, never a save.
    return null;
  }
}
