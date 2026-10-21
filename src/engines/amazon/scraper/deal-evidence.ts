/**
 * SAD-386: one place that decides whether a page proves a *deal* is running.
 *
 * Why a module instead of two regexes? Before this change the business rule was
 * written twice — `field-parsers.ts` (cards) and `product-detail.ts` (PDPs) —
 * with different vocabularies, so "Cyber Monday" was a deal on a card and not on
 * a product page (plan §5 F7). One shared pattern removes the drift.
 *
 * Two rules this module enforces:
 *
 * 1. **A printed badge text always wins.** `detectDealEvidence` returns the
 *    page's own wording when it can read it.
 * 2. **A derived value says so.** When the page proves a deal is running but no
 *    badge text is readable, the canonical `DERIVED_DEAL_LABEL` is returned with
 *    `derived: true`, so diagnostics can report provenance instead of pretending
 *    Amazon printed that text.
 *
 * It deliberately does **not** import the parsers, so there is no import cycle:
 * the only dependency is the safe query helper.
 */
import { safeQuerySelectorAll } from './selectors';
import { sanitizeDealBadge } from '../utils/deal-text';

/** SAD-386 (operator decision D1): the text stored when a deal is proven without a badge. */
export const DERIVED_DEAL_LABEL = 'Deal';

/**
 * SAD-386 (operator decision D5: *"struck list price also qualifies"*).
 *
 * One switch, one place. When `true`, a product whose struck-through list price
 * is above its selling price counts as a deal even with no badge and no label.
 * Flip to `false` to return to "label/container evidence only" — nothing else
 * changes.
 */
export const TREAT_STRUCK_LIST_PRICE_AS_DEAL = true;

/**
 * The union of the vocabulary both call sites used before, plus the event names
 * the card list already knew and the PDP list did not.
 */
export const DEAL_LABEL_PATTERN =
  /limited[- ]?time deal|lightning deal|deal of the day|best deal|prime big deal|deal price|cyber monday|black friday|prime day|angebot|offre|oferta|\bdeals?\b/i;

/**
 * Containers that can ONLY be a deal badge: the attribute or class name says
 * "deal", so their text is accepted without a vocabulary check.
 *
 * `[data-a-badge-type="deal"]` without the descendant class is deliberate: real
 * cards put the attribute on the text node itself (probe P02/D).
 */
export const DEAL_SPECIFIC_CONTAINER_SELECTORS: readonly string[] = [
  '[data-a-badge-type="deal"]',
  '[class*="dealBadge" i]',
  '[id*="dealBadge" i]',
];

/**
 * Containers that are *shared* with other badges — the status-badge slot also
 * renders "Amazon's Choice" and "Best Seller".
 *
 * They are only a deal when their text passes `DEAL_LABEL_PATTERN`; without that
 * rule "Amazon's Choice" was reported as a deal (caught by
 * `tests/sad-386-card-deal.test.ts`).
 */
export const AMBIGUOUS_CONTAINER_SELECTORS: readonly string[] = [
  '[data-component-type="s-status-badge-component"] .a-badge-text',
];

/** Every extra container, for callers that apply their own vocabulary check. */
export const DEAL_CONTAINER_SELECTORS: readonly string[] = [
  ...DEAL_SPECIFIC_CONTAINER_SELECTORS,
  ...AMBIGUOUS_CONTAINER_SELECTORS,
];

/** Short nodes only: a deal badge is a label, not a paragraph. */
const MAX_BADGE_TEXT_LENGTH = 60;

/** A label is not a price. */
const PRICE_TOKEN = /[$€£¥₹₺]|\d+[.,]\d{2}|\d+\s*%/;

/**
 * Regions whose text is never a badge: the product title ("Deal Dash Board Game"
 * is a product name, not a deal), the review/rating block, the delivery promise
 * and the coupon line. Caught by `tests/sad-386-card-deal.test.ts`.
 */
const NON_BADGE_REGIONS = [
  '[data-cy="title-recipe"]',
  '[data-cy="reviews-block"]',
  '[data-cy="delivery-recipe"]',
  '.s-coupon-unclipped',
  '[data-component-type="s-coupon-component"]',
  'h1',
  'h2',
];

function clean(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface EvidenceOptions {
  /**
   * SAD-386: nodes this predicate rejects are invisible to the scan. The product
   * page passes its excluded-subtree rule here so a similar-items carousel can
   * never answer for the product ("-90%" and "Limited time deal" leaked from
   * `#sims-consolidated` before this parameter existed).
   */
  skip?: (el: Element) => boolean;
}

export interface DealEvidence {
  /** The text to store: the page's own badge text, or `DERIVED_DEAL_LABEL`. */
  value: string;
  /** `true` when no badge text was readable and the value is derived. */
  derived: boolean;
}

/**
 * Reads a deal badge from `root`, or proves one exists without readable text.
 *
 * Order: badge containers (page wording) → short-text label scan (page wording)
 * → a container that exists but carries no label (derived).
 * A struck list price is handled by the caller, which owns the prices.
 */
export function detectDealEvidence(
  root: Element,
  options: EvidenceOptions = {},
): DealEvidence | undefined {
  const skip = options.skip ?? (() => false);
  let emptyContainerSeen = false;

  // Deal-specific containers: the markup itself says "deal", so the page's own
  // text is the answer even if the wording is unusual ("Deal", "Blitzangebot").
  for (const selector of DEAL_SPECIFIC_CONTAINER_SELECTORS) {
    for (const el of safeQuerySelectorAll(root, selector)) {
      if (skip(el)) continue;
      // SAD-387: strip Amazon's countdown templates before the length/vocabulary
      // checks, so a template blob is judged by the label it actually carries.
      const text = sanitizeDealBadge(clean(el.textContent)) ?? '';
      if (!text) {
        emptyContainerSeen = true;
        continue;
      }
      if (text.length <= MAX_BADGE_TEXT_LENGTH && !PRICE_TOKEN.test(text)) {
        return { value: text, derived: false };
      }
      emptyContainerSeen = true;
    }
  }

  // Shared slots (status badge) and any other container: the TEXT must prove it
  // is a deal, because the same slot also carries "Amazon's Choice".
  for (const selector of AMBIGUOUS_CONTAINER_SELECTORS) {
    for (const el of safeQuerySelectorAll(root, selector)) {
      if (skip(el)) continue;
      // SAD-387: strip Amazon's countdown templates before the length/vocabulary
      // checks, so a template blob is judged by the label it actually carries.
      const text = sanitizeDealBadge(clean(el.textContent)) ?? '';
      if (!text) {
        emptyContainerSeen = true;
        continue;
      }
      if (
        text.length <= MAX_BADGE_TEXT_LENGTH &&
        !PRICE_TOKEN.test(text) &&
        DEAL_LABEL_PATTERN.test(text)
      ) {
        return { value: text, derived: false };
      }
    }
  }

  for (const el of safeQuerySelectorAll(root, 'span, div, p, b, strong')) {
    // Leaf-ish nodes only: a container's text includes its children's text.
    if (el.children.length > 2) continue;
    if (skip(el)) continue;
    if (el.closest(NON_BADGE_REGIONS.join(', '))) continue;
    if (el.querySelector('a[href*="/dp/"]')) continue; // a title link is not a badge
    // SAD-387: strip Amazon's countdown templates before the length/vocabulary
      // checks, so a template blob is judged by the label it actually carries.
      const text = sanitizeDealBadge(clean(el.textContent)) ?? '';
    if (!text || text.length > MAX_BADGE_TEXT_LENGTH) continue;
    if (PRICE_TOKEN.test(text)) continue;
    if (DEAL_LABEL_PATTERN.test(text)) {
      return { value: text, derived: false };
    }
  }

  if (emptyContainerSeen) {
    return { value: DERIVED_DEAL_LABEL, derived: true };
  }

  return undefined;
}

/**
 * The struck-list-price rule (D5). Returns the derived value only when the
 * caller has both prices and the list price is strictly higher.
 */
export function deriveDealFromPrices(
  price: number | null,
  listPrice: number | undefined,
): DealEvidence | undefined {
  if (!TREAT_STRUCK_LIST_PRICE_AS_DEAL) return undefined;
  if (price === null || listPrice === undefined) return undefined;
  if (!(listPrice > price)) return undefined;
  return { value: DERIVED_DEAL_LABEL, derived: true };
}
