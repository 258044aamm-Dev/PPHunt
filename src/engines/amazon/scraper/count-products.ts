import { filterLeafCandidateCards } from './category-page';
import { safeQuerySelectorAll } from './selectors';

const SCOPED_PRODUCT_CARD_SELECTORS = [
  '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
  '.s-result-item[data-asin]:not([data-asin=""])',
  '#gridItemRoot',
  '.zg-grid-general-faceout',
  '[id^="p13n-asin-index-"]',
  '[data-p13n-asin-metadata]',
  '[data-testid="product-card"]',
  '[data-testid="grid-deals-container"] [data-testid*="deal-card"]',
  '[data-testid*="deal-card"]',
  '.octopus-pc-item',
] as const;

/**
 * Counts real scoped product cards in the document while ignoring peripheral
 * recommendation carousels (`.a-carousel-card`) and footer `/dp/` links.
 */
export function countProductCards(doc?: Document | null): number {
  const activeDoc =
    doc ?? (typeof document !== 'undefined' ? document : null);
  if (!activeDoc) return 0;

  const candidates = safeQuerySelectorAll(
    activeDoc,
    SCOPED_PRODUCT_CARD_SELECTORS.join(', '),
  ).filter((el) => !el.closest('.a-carousel-card, [id*="sp_detail"], [id*="sims-consolidated"]'));

  const leafCards = filterLeafCandidateCards(candidates);
  return leafCards.length;
}
