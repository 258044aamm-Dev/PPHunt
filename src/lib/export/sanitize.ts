/**
 * Characters that cause Excel / Google Sheets / LibreOffice Calc to interpret a
 * cell as a formula rather than text when the value is loaded from CSV or pasted
 * from the clipboard. Tab and CR are included because they are documented
 * bypasses of naive `=`-only filters.
 */
const FORMULA_LEAD = /^([=+\-@\t\r])/;

/**
 * Prefixes a leading apostrophe so the value is treated as literal text.
 * Returns the input unchanged when it does not start with a trigger character.
 *
 * The leading apostrophe is the standard mitigation (H-6): invisible in the
 * rendered cell, preserved in the formula bar. Prefixing a space would alter
 * visible content and break downstream VLOOKUP/TRIM-free workflows.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}
