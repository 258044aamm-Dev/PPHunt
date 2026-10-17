/**
 * Temu Price & Compact Count Parser (US English / USD primary, multi-currency ready).
 * Never fabricates or calculates missing values.
 */

const CURRENCY_SYMBOL_TO_ISO: Array<[RegExp, string]> = [
  [/US\$|\bUSD\b/i, 'USD'],
  [/CA\$|C\$|\bCAD\b/i, 'CAD'],
  [/AU\$|A\$|\bAUD\b/i, 'AUD'],
  [/£|\bGBP\b/i, 'GBP'],
  [/€|\bEUR\b/i, 'EUR'],
  [/¥|￥|\bJPY\b/i, 'JPY'],
  [/\$ /, 'USD'],
  [/\$/, 'USD'],
];

/**
 * Infers ISO 4217 currency code from a raw price string, defaulting to `fallbackCurrency` ('USD').
 */
export function detectTemuCurrency(
  rawText: string | null | undefined,
  fallbackCurrency = 'USD'
): string {
  if (!rawText) return fallbackCurrency;
  for (const [pattern, iso] of CURRENCY_SYMBOL_TO_ISO) {
    if (pattern.test(rawText)) {
      return iso;
    }
  }
  return fallbackCurrency;
}

/**
 * Parses a formatted price string (e.g. "$12.49", "US$ 1,249.00", "Original price $39.99")
 * into `{ value: number | null, currency: string | null }`.
 */
export function parseTemuPrice(
  rawText: string | null | undefined,
  fallbackCurrency = 'USD'
): { value: number | null; currency: string | null } {
  if (!rawText) return { value: null, currency: null };

  const cleaned = rawText
    .replace(/[\u200B-\u200F\uFEFF\u00A0]/g, ' ')
    .trim();
  if (!cleaned) return { value: null, currency: null };

  // Ignore pure percentage strings like "-68%" or "68% off"
  if (/^[-−–+]?\s*\d+(?:[.,]\d+)?\s*%(?:\s*off)?$/i.test(cleaned)) {
    return { value: null, currency: null };
  }

  // Extract numeric token allowing thousands separators and decimal fraction
  const numMatch = cleaned.match(
    /(?:US\$|CA\$|AU\$|C\$|A\$|[\$€£¥￥]|USD|EUR|GBP|CAD|AUD|JPY)?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|\d+(?:[.,]\d{1,2})?)/i
  );
  if (!numMatch?.[1]) {
    return { value: null, currency: null };
  }

  let numericToken = numMatch[1];

  // Normalize comma/dot separators:
  // If both ',' and '.' exist, whichever comes last is the decimal point.
  const lastComma = numericToken.lastIndexOf(',');
  const lastDot = numericToken.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastDot > lastComma) {
      numericToken = numericToken.replace(/,/g, '');
    } else {
      numericToken = numericToken.replace(/\./g, '').replace(',', '.');
    }
  } else if (lastComma !== -1) {
    // Only comma present: if followed by 2 digits at end, treat as decimal; if 3 digits, thousands separator
    const parts = numericToken.split(',');
    if (parts.length === 2 && parts[1] && parts[1].length <= 2) {
      numericToken = `${parts[0]}.${parts[1]}`;
    } else {
      numericToken = numericToken.replace(/,/g, '');
    }
  }

  const parsed = Number.parseFloat(numericToken);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: null, currency: null };
  }

  const value = Math.round(parsed * 100) / 100;
  const currency = detectTemuCurrency(cleaned, fallbackCurrency);
  return { value, currency };
}

/**
 * Parses a split integer + fraction price block (used by Temu's visual price spans when `.srOnly` is absent).
 */
export function parseTemuSplitPrice(
  integerText: string | null | undefined,
  decimalText: string | null | undefined,
  currencyText: string | null | undefined,
  fallbackCurrency = 'USD'
): { value: number | null; currency: string | null } {
  const intDigits = (integerText ?? '').replace(/[^\d]/g, '');
  if (!intDigits) return { value: null, currency: null };

  const decDigits = (decimalText ?? '').replace(/[^\d]/g, '');
  const combined = decDigits ? `${intDigits}.${decDigits.slice(0, 2)}` : intDigits;
  const parsed = Number.parseFloat(combined);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: null, currency: null };
  }

  const value = Math.round(parsed * 100) / 100;
  const currency = detectTemuCurrency(currencyText, fallbackCurrency);
  return { value, currency };
}

/**
 * Normalizes a Temu sales velocity / sold tips string (e.g. "10K+ sold", "2.4K+ sold in past month", "850 sold").
 * Never fabricates a sales string if none is present.
 */
export function normalizeTemuSalesText(
  rawText: string | null | undefined
): string | null {
  if (!rawText) return null;
  const cleaned = rawText
    .replace(/[\u200B-\u200F\uFEFF\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  const match = cleaned.match(
    /\b(\d+(?:[.,]\d+)?\s*[KkMm]?\+?\s*sold(?:\s+in\s+[^.|,;]+)?)\b/i
  );
  if (match?.[1]) {
    return match[1].trim();
  }
  return null;
}
