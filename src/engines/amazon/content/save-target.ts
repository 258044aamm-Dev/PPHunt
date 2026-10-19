import {
  discoverStructuralProductCards,
  extractCardAsinWithTier,
} from '../scraper';
import { AMAZON_SELECTORS } from '../scraper/selectors';
import { extractASIN } from '../utils/amazon-url';

/**
 * SAD-280 (plan 8.1) - turn "where the user right-clicked" into "which product".
 *
 * Chrome's `contextMenus.onClicked` carries no element, so the content script
 * remembers the element under the pointer at `contextmenu` time and resolves it
 * here, on demand, when the background asks for a save.
 */

/**
 * How long a captured element stays usable, as a backstop.
 *
 * SAD-341: this used to be 5 s — shorter than a human takes to read a context
 * menu. Opening the menu, thinking for a moment and then clicking "Save
 * product" failed with "No product found here" even though the capture was
 * still perfectly valid.
 *
 * The TTL is no longer what keeps a capture honest. Two cheaper checks do:
 *
 * 1. every `contextmenu`/`mousedown` overwrites the previous capture, so a
 *    capture can never outlive the click that produced it;
 * 2. `resolveCapturedCard` refuses any capture whose `pageUrl` differs from
 *    `location.href`, so it cannot be carried across a navigation.
 *
 * Ten minutes is long enough that nobody can outwait it in the normal flow and
 * short enough that a capture abandoned on an idle tab cannot be reused much
 * later. Note that a *newer* capture always wins regardless of age.
 */
export const CONTEXT_CAPTURE_TTL_MS = 10 * 60 * 1_000;

/**
 * Card containers the collectors already understand. Kept as one list so the
 * resolver and the scraper cannot disagree about what a card is.
 */
export const SAVABLE_CARD_SELECTORS: readonly string[] = [
  ...AMAZON_SELECTORS.search.cardContainers,
  ...AMAZON_SELECTORS.category.bestSellerCards,
  ...AMAZON_SELECTORS.category.dealCards,
  ...AMAZON_SELECTORS.category.browseCards,
];

/**
 * Regions that never contain the card the user meant: site chrome, the
 * "related / recommended" rails, and carousels. The structural discovery used
 * as a fallback skips the same subtrees.
 */
export const EXCLUDED_CARD_REGIONS = [
  '#navFooter',
  '#navbar',
  '#rhf',
  '[id*="sp_detail"]',
  '[id*="sims-consolidated"]',
  '.a-carousel-card',
  '[data-csa-c-content-id*="sims"]',
];

const COMBINED_CARD_SELECTOR = SAVABLE_CARD_SELECTORS.join(', ');
const EXCLUDED_SELECTOR = EXCLUDED_CARD_REGIONS.join(', ');

export interface CapturedSaveTarget {
  element: Element | null;
  capturedAt: number;
  pageUrl: string;
}

function currentPageUrl(): string {
  return typeof location === 'undefined' ? '' : location.href;
}

/** Reads the element under the pointer out of a `contextmenu`/`mousedown` event. */
export function captureSaveTarget(
  event: Event,
  now: number = Date.now(),
): CapturedSaveTarget {
  const target = event?.target;
  let element: Element | null = null;

  if (target && typeof (target as Element).closest === 'function') {
    element = target as Element;
  } else if (target && (target as Node).parentElement) {
    element = (target as Node).parentElement as Element;
  }

  return { element, capturedAt: now, pageUrl: currentPageUrl() };
}

/**
 * True when a capture is young enough to be used at all. This is the cheap
 * backstop — the *page* check lives in `resolveCapturedCard` and is the one
 * that actually prevents a wrong product from being saved.
 */
export function isCaptureFresh(
  capture: CapturedSaveTarget | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!capture) return false;
  if (!Number.isFinite(capture.capturedAt)) return false;
  const age = now - capture.capturedAt;
  return age >= 0 && age <= CONTEXT_CAPTURE_TTL_MS;
}

function cardAsin(card: Element): string | null {
  const value = extractCardAsinWithTier(card).value;
  return value && /^[A-Z0-9]{10}$/.test(value) ? value : null;
}

/**
 * The smallest element that is a product card containing `element`, or null.
 *
 * Order matters: the declarative selectors come first (they are what the
 * collectors trust), the structural `/dp/` anchor clustering is only a fallback
 * for markup the registry does not know yet.
 */
export function resolveSavableCard(
  element: Element | null,
  now: number = Date.now(),
): Element | null {
  if (!element || typeof element.closest !== 'function') return null;

  const excluded = element.closest(EXCLUDED_SELECTOR);
  if (excluded) return null;

  const declarative = element.closest(COMBINED_CARD_SELECTOR);
  if (declarative && cardAsin(declarative)) return declarative;

  const doc = element.ownerDocument;
  if (!doc?.body) return null;

  let smallest: Element | null = null;
  for (const candidate of discoverStructuralProductCards(doc.body)) {
    if (!candidate.contains(element)) continue;
    if (!cardAsin(candidate)) continue;
    if (!smallest || smallest.contains(candidate)) smallest = candidate;
  }

  if (!smallest) return null;
  return narrowToSingleProduct(smallest, element);
}

/** Every distinct ASIN reachable through a `/dp/` anchor below `root`. */
function asinsWithin(root: Element): Set<string> {
  const asins = new Set<string>();
  const anchors = root.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/dp/"], a[href*="/gp/product/"]',
  );

  for (const anchor of anchors) {
    const asin = extractASIN(anchor.getAttribute('href'));
    if (asin) asins.add(asin);
  }
  return asins;
}

/**
 * Structural discovery answers "which container holds this anchor", which can be
 * a wrapper spanning several products on unfamiliar markup. Saving one product
 * from a two-product container would be wrong, so walk back down from the
 * clicked element to the smallest ancestor holding exactly one ASIN. When even
 * that is ambiguous, return null instead of guessing.
 */
function narrowToSingleProduct(candidate: Element, element: Element): Element | null {
  if (asinsWithin(candidate).size <= 1) return candidate;

  let cursor: Element | null = element;
  while (cursor && cursor !== candidate) {
    if (asinsWithin(cursor).size === 1) return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}

/**
 * Resolves the card for a previously captured target, refusing a stale capture
 * or one taken on a different page.
 *
 * Both refusals are independent, and the page check is deliberate rather than a
 * side effect of the age check: a capture is only meaningful for the document
 * it was taken in.
 */
export function resolveCapturedCard(
  capture: CapturedSaveTarget | null | undefined,
  now: number = Date.now(),
): Element | null {
  if (!isCaptureFresh(capture, now)) return null;
  if (!capture) return null;
  if (capture.pageUrl && capture.pageUrl !== currentPageUrl()) return null;
  return resolveSavableCard(capture.element, now);
}
