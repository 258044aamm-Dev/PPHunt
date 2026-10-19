import {
  detectAmazonPageType,
  parseAmazonCategoryCard,
  parseAmazonProductDetail,
  parseAmazonSearchCard,
} from '../scraper';
import { AMAZON_SELECTORS } from '../scraper/selectors';
import type { SaveExtractionContext, ScrapedProduct } from '../types';
import { resolveCapturedCard, type CapturedSaveTarget } from './save-target';

/**
 * SAD-281 (plan 9): from "the user right-clicked here" to one product plus the
 * context that describes the observation. Both entry points share this module -
 * the card button will call the same function with a card it already knows.
 */

export interface ResolvedSaveCandidate {
  product: ScrapedProduct;
  context: SaveExtractionContext;
}

const SPONSORED_HINT_SELECTOR =
  '.puis-sponsored-label-text, [data-component-type="sp-sponsored-result"], [aria-label*="Sponsored" i]';

/** Search-card parser first, category/deal parser second. */
export function extractProductFromCard(
  card: Element,
  pageUrl: string,
): ScrapedProduct | null {
  return (
    parseAmazonSearchCard(card, pageUrl) ??
    parseAmazonCategoryCard(card, pageUrl)
  );
}

/**
 * Context is what makes a snapshot explainable later: which page, which trigger,
 * which position and whether the placement was paid.
 */
export function buildSaveContext(
  card: Element | null,
  pageUrl: string,
  triggeredBy: SaveExtractionContext['triggeredBy'],
  doc: Document = document,
): SaveExtractionContext {
  const pageType = detectAmazonPageType(pageUrl, doc);
  const context: SaveExtractionContext = { pageType, pageUrl, triggeredBy };

  if (card && pageType === 'search') {
    const cards = Array.from(
      doc.querySelectorAll(AMAZON_SELECTORS.search.productCard),
    );
    const index = cards.indexOf(card);
    if (index >= 0) context.searchPosition = index + 1;

    context.listingCategory = card.querySelector(SPONSORED_HINT_SELECTOR)
      ? 'sponsored'
      : 'organic';
  }

  return context;
}

export interface ResolveSaveCandidateInput {
  capture: CapturedSaveTarget | null;
  pageUrl: string;
  triggeredBy: SaveExtractionContext['triggeredBy'];
  now?: number;
  doc?: Document;
}

/**
 * Product-detail pages have no card: the whole document is the product.
 * Everywhere else the captured element is resolved to exactly one card, or the
 * answer is "no product".
 */
export function resolveSaveCandidate(
  input: ResolveSaveCandidateInput,
): ResolvedSaveCandidate | null {
  const doc = input.doc ?? document;
  const pageType = detectAmazonPageType(input.pageUrl, doc);

  if (pageType === 'product-detail') {
    const product = parseAmazonProductDetail(doc, input.pageUrl);
    if (!product) return null;
    return {
      product,
      context: {
        pageType,
        pageUrl: input.pageUrl,
        triggeredBy: input.triggeredBy,
      },
    };
  }

  const card = resolveCapturedCard(input.capture, input.now ?? Date.now());
  if (!card) return null;

  const product = extractProductFromCard(card, input.pageUrl);
  if (!product) return null;

  return {
    product,
    context: buildSaveContext(card, input.pageUrl, input.triggeredBy, doc),
  };
}
