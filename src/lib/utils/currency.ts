import { inferCurrencyFromUrl } from './price-parser';

const ISO_4217 = /^[A-Z]{3}$/;

/** True only for a bare three-letter uppercase code. */
export function isIsoCurrency(value: unknown): value is string {
  return typeof value === 'string' && ISO_4217.test(value);
}

/**
 * Resolves the currency implied by an Amazon page URL.
 * Returns null (never a URL, never a guess) when the host is not recognised.
 */
export function resolvePageCurrency(
  pageUrl: string | null | undefined
): string | null {
  const inferred = inferCurrencyFromUrl(pageUrl);
  return isIsoCurrency(inferred) ? inferred : null;
}
