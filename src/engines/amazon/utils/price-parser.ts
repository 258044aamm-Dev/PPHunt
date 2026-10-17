import { resolveAmazonCurrency } from './currency';

export interface ParsedAmazonPrice {
  price: number | null;
  currency: string;
}

/**
 * Extracts a numeric price amount from localized Amazon price text:
 * - US/UK/JP/IN: "$1,299.99", "£49.50", "¥2,980", "₹1,49,999.00"
 * - EU: "1.299,99 €", "29,99€", "19,90 €"
 * - Space/apostrophe thousands: "1 299,00 zł", "CHF 1'249.50"
 *
 * Returns `null` when no valid non-negative price is present (never fabricates 0).
 */
export function parsePriceAmount(raw: string | null | undefined): number | null {
  if (!raw || typeof raw !== 'string') return null;

  // Normalize non-breaking spaces and strip invisible bidi characters
  const cleaned = raw
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .trim();
  if (!cleaned) return null;

  // Match the first plausible numeric token (supporting '.', ',', space, or "'" separators)
  const tokenMatch = cleaned.match(
    /(?:^|[^\d/])(\d{1,3}(?:[.,'\s]\d{2,3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\s*%)/,
  );
  if (!tokenMatch?.[1]) {
    return null;
  }

  let numericToken = tokenMatch[1].trim().replace(/['\s]/g, '');
  if (!numericToken) return null;

  const lastDot = numericToken.lastIndexOf('.');
  const lastComma = numericToken.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) {
      // European format: "1.299,99" -> "1299.99"
      numericToken = numericToken.replace(/\./g, '').replace(',', '.');
    } else {
      // US/UK format: "1,299.99" -> "1299.99"
      numericToken = numericToken.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const commaCount = (numericToken.match(/,/g) ?? []).length;
    const digitsAfterComma = numericToken.length - lastComma - 1;

    if (commaCount === 1 && (digitsAfterComma === 1 || digitsAfterComma === 2)) {
      // Decimal comma: "29,99" or "29,9"
      numericToken = numericToken.replace(',', '.');
    } else if (commaCount > 1 && digitsAfterComma === 2) {
      // Rare mixed format: "1,299,99"
      numericToken =
        numericToken.slice(0, lastComma).replace(/,/g, '') +
        '.' +
        numericToken.slice(lastComma + 1);
    } else {
      // Thousands comma(s): "2,980" or "1,49,999"
      numericToken = numericToken.replace(/,/g, '');
    }
  } else if (lastDot !== -1) {
    const dotCount = (numericToken.match(/\./g) ?? []).length;
    const digitsAfterDot = numericToken.length - lastDot - 1;

    if (dotCount > 1) {
      // Multiple dots: "1.299.000" -> thousands separator
      numericToken = numericToken.replace(/\./g, '');
    } else if (digitsAfterDot === 3 && !cleaned.includes('$') && !cleaned.includes('£')) {
      // Single dot with 3 trailing digits in non-US/UK context (e.g. "1.299 €")
      numericToken = numericToken.replace(/\./g, '');
    }
  }

  const parsed = Number.parseFloat(numericToken);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.round(parsed * 100) / 100;
}

/**
 * Parses both numeric amount and ISO 4217 currency from a raw price string and optional page URL.
 */
export function parsePriceText(
  raw: string | null | undefined,
  pageUrl?: string | null,
): ParsedAmazonPrice {
  const currency = resolveAmazonCurrency(raw, pageUrl);
  const price = parsePriceAmount(raw);
  return { price, currency };
}
