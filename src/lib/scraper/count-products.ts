/**
 * Step 5.3 (SAD-179) — M-2: the automatic-mode DOM growth counter.
 *
 * Counts ONLY real product cards: the union of the two card selectors the
 * parsers themselves use. The previous inline union in amazon.content.ts also
 * matched `[data-asin]:not([data-asin=""])` (subsumed — SELECTORS.category
 * .productCard already matches every `[data-asin]` element) and
 * `a[href*="/dp/"]`, which matches recommendation carousels, "customers also
 * bought" shelves, sponsored slots and footer links. When peripheral content
 * lazy-loaded, that inflated count grew, ScrollController.tick reset
 * staleCount and triggered a full re-parse that dedup reduced to zero —
 * wasted work plus delayed end-of-page detection (1,500 nodes / 92 ms per
 * tick measured on a 480-card page).
 *
 * Note: parseCategoryPage can additionally discover containers via /dp/ links
 * when no card-selector elements exist at all; on such pages this counter
 * stays 0 and automatic mode ends after the initial parse — the same final
 * product set, without the wasted ticks.
 */
import { SELECTORS } from './selectors';

/** Number of real product-card elements currently in the document. */
export function countProductCards(document: Document): number {
  return document.querySelectorAll(
    `${SELECTORS.search.productCard}, ${SELECTORS.category.productCard}`
  ).length;
}
