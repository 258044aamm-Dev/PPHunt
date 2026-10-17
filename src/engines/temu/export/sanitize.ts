/**
 * Characters that cause Excel / Google Sheets / LibreOffice Calc to interpret a
 * cell as a formula rather than text when loaded from CSV or pasted from the clipboard.
 */
const FORMULA_LEAD = /^([=+\-@\t\r])/;

/**
 * Prefixes a leading apostrophe so spreadsheet applications treat the cell as literal text.
 */
export function neutralizeTemuSpreadsheetFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}
