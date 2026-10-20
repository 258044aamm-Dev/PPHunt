/**
 * SAD-360 — types for the live measurement harness.
 *
 * The harness is a plain `.mjs` spike script (nothing in `src/` imports it),
 * but its comparison logic is unit-tested, so the exports it exposes to the
 * test suite need declarations.
 */

export interface MeasurementOptions {
  pdps: string[];
  listing: string | null;
  out: string;
  settleMs: number;
  targetCount: number;
  help?: boolean;
}

export type TemuDiagnosticStatus =
  | 'EXTRACTED'
  | 'MISSING'
  | 'PARSE_FAILED'
  | 'PARTIAL'
  | 'UNKNOWN';

export interface HarnessField {
  field: string;
  status: TemuDiagnosticStatus;
  validated?: boolean;
}

export interface HarnessReport {
  goodsId: string | null;
  stage: string;
  counts?: Record<string, number>;
  fields: HarnessField[];
}

export interface VerifiedReport {
  goodsId: string | null;
  stage: string;
  counts?: Record<string, number>;
  storedProductPresent: boolean;
  mismatches: Array<{ field: string; status: string; problem: string }>;
}

export const PREFIX: string;
export const TEMU_DB_NAME: string;

export function parseArgs(argv: string[]): MeasurementOptions;
export function usage(): void;
export function pdpUrl(input: string): string;
export function isEmpty(value: unknown): boolean;
export function verifyField(
  field: HarnessField,
  stored: Record<string, unknown> | null
): string | null;
export function verifyReports(
  reports: HarnessReport[],
  storedRows: Array<Record<string, unknown>>
): VerifiedReport[];
export function main(argv?: string[]): Promise<number>;
