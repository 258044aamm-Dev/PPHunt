const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

/**
 * Neutralizes spreadsheet formula injection (CSV/TSV/XLSX) by prefixing a leading
 * single quote (`'`) whenever a string cell begins with `=`, `+`, `-`, `@`, `\t`, or `\r`.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  if (!value) return value;
  return FORMULA_TRIGGER_RE.test(value) ? `'${value}` : value;
}
