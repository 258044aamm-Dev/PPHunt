import { cleanTemuText, extractTemuElementText } from './field-parsers';
import { TEMU_SELECTORS } from './selectors';

/**
 * SAD-381: Temu PDP `features` and `description` extraction.
 *
 * Derived from Temu's own PDP bundle — `goods_3ec530fb9c64b2d4fc2a.js`, the
 * script the live product page loads — not from assumed markup:
 *
 * - `GoodsDetailV2` emits `<div id="goodsDetail">`, whose children (in render
 *   order) are a heading ("Product details"), the `Highlight` module
 *   (`data-id="module"`, rows carry `aria-label`), compliance text, a
 *   `goodsProperty` list rendered as `Key: value` **divs**, attribute `<li>`s
 *   (names only), the `GoodsPropertyTable` (`<table><tr><th/><td/>`), and
 *   image-only description floors.
 * - `DescriptionV2` emits a `data-id="module"` block inside `#rightContent`
 *   whose rows are `div[role="button"][aria-label="$<value>"]`.
 * - Both collapse: `slice(0, rows || 6)` / `rows || 3` rows plus a "See more"
 *   control, so a read-only pass can return a prefix. That is surfaced as
 *   `collapsed` and reported as PARTIAL, never silently.
 *
 * Nothing here depends on Temu's hashed CSS-module class names (forbidden by
 * `selectors.ts`), and no value is ever synthesised: an absent source yields
 * `[]` / `null`.
 */

/** Locale-resolved labels, read from the page's own i18n store. */
export interface TemuPdpLabels {
  highlight: string;
  description: string;
  details: string;
  seeAll: string;
  seeAllDimensions: string;
  seeMore: string;
  seeMoreProductDetails: string;
  seeMoreProperties: string;
}

/** English values, used when the store is missing or unreadable. */
export const TEMU_PDP_FALLBACK_LABELS: TemuPdpLabels = Object.freeze({
  highlight: 'Highlights',
  description: 'Description',
  details: 'Product details',
  seeAll: 'See all details',
  seeAllDimensions: 'See all details and dimensions',
  seeMore: 'See more',
  seeMoreProductDetails: 'See more product details',
  seeMoreProperties: 'See more properties',
});

export interface FeatureEvidence {
  features: string[];
  /** A collapse control is still present: what was read is a prefix. */
  collapsed: boolean;
  /** Rows seen before filtering — separates "absent" from "rejected". */
  candidates: number;
  source: 'details-section' | 'right-column-highlights' | 'none';
}

export interface DescriptionEvidence {
  description: string | null;
  source: 'description-module' | 'none';
  collapsed: boolean;
  candidates: number;
}

/** Keys that already have dedicated fields; never duplicated into features. */
const FEATURE_KEY_DENYLIST = new Set([
  'seller',
  'sold by',
  'ships from',
  'shipping',
  'delivery',
  'returns',
  'return',
  'price',
  'coupon',
  'discount',
  'stock',
  'availability',
]);

/** `Key: value` — at most 40 chars of key, then a colon and a value. */
const KEY_VALUE = /^[A-Za-z][^:]{1,40}:\s*\S/;

/** Today's cap in `extractTemuPdpFeatures`, preserved deliberately. */
const MAX_FEATURES = 15;

/** Description rows are joined with this separator (`cleanTemuText` collapses
 *  newlines, so a single-line join keeps the value one clean field). */
const DESCRIPTION_SEPARATOR = ' · ';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const storeCache = new WeakMap<Document, JsonObject | null>();

/**
 * Parses the `window.__InitialI18nStore__` object out of the page's inline
 * scripts.
 *
 * A content script runs in an isolated world and cannot read the page's
 * `window`, so the value has to be recovered from the script **text**. The
 * literal is plain JSON (verified: 207,822 chars, `JSON.parse` clean on a live
 * PDP), so a string/escape-aware brace scan is enough to isolate it.
 */
function readInitialI18nStore(doc: Document): JsonObject | null {
  const cached = storeCache.get(doc);
  if (cached !== undefined) return cached;

  let parsed: JsonObject | null = null;
  try {
    const script = Array.from(doc.querySelectorAll('script:not([src])')).find(
      (node) => (node.textContent ?? '').includes('__InitialI18nStore__')
    );
    const text = script?.textContent ?? '';
    const assignment = text.indexOf('__InitialI18nStore__');
    const start = assignment >= 0 ? text.indexOf('{', assignment) : -1;

    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;

      for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }

      if (end > start) {
        const candidate: unknown = JSON.parse(text.slice(start, end + 1));
        parsed = isRecord(candidate) ? candidate : null;
      }
    }
  } catch {
    parsed = null;
  }

  storeCache.set(doc, parsed);
  return parsed;
}

/**
 * Resolves the module labels for the current storefront from the page's own
 * i18n store, falling back to English. Never throws.
 */
export function readTemuPdpLabels(doc: Document): TemuPdpLabels {
  try {
    const store = readInitialI18nStore(doc);
    const locale = store ? Object.values(store)[0] : null;
    const goods =
      isRecord(locale) && isRecord(locale.goods) ? locale.goods : null;
    const main = goods && isRecord(goods.main_detail) ? goods.main_detail : null;
    const detail =
      goods && isRecord(goods.goodsDetail) ? goods.goodsDetail : null;

    const pick = (group: JsonObject | null, key: string): string | null => {
      const value = group?.[key];
      if (typeof value !== 'string') return null;
      const cleaned = cleanTemuText(value);
      return cleaned && cleaned.length <= 60 ? cleaned : null;
    };

    return {
      highlight:
        pick(main, 'highlight') ?? TEMU_PDP_FALLBACK_LABELS.highlight,
      description:
        pick(main, 'descriptionTitle') ?? TEMU_PDP_FALLBACK_LABELS.description,
      details:
        pick(detail, 'goodsDetailTitle') ?? TEMU_PDP_FALLBACK_LABELS.details,
      seeAll: pick(detail, 'descriptionSeeAll') ?? TEMU_PDP_FALLBACK_LABELS.seeAll,
      seeAllDimensions:
        pick(detail, 'descriptionMoreWithDimension') ??
        TEMU_PDP_FALLBACK_LABELS.seeAllDimensions,
      seeMore:
        pick(main, 'descriptionMore') ?? TEMU_PDP_FALLBACK_LABELS.seeMore,
      seeMoreProductDetails:
        pick(goods, 'accessSeeMoreProductDetails') ??
        TEMU_PDP_FALLBACK_LABELS.seeMoreProductDetails,
      seeMoreProperties:
        pick(goods, 'accessSeeMoreGoodsProperties') ??
        TEMU_PDP_FALLBACK_LABELS.seeMoreProperties,
    };
  } catch {
    return TEMU_PDP_FALLBACK_LABELS;
  }
}

/**
 * Every string a collapse control may expose, lower-cased.
 *
 * The English values are always included alongside the resolved ones: Temu
 * renders English controls on non-English storefronts (and A/B variants ship a
 * store that lags the DOM), and an unfiltered control would end up *inside* the
 * description. Including both can only remove UI strings — none of these five
 * is legitimate product data.
 */
function controlLabels(labels: TemuPdpLabels): Set<string> {
  const values = [
    labels.seeAll,
    labels.seeAllDimensions,
    labels.seeMore,
    labels.seeMoreProductDetails,
    labels.seeMoreProperties,
    TEMU_PDP_FALLBACK_LABELS.seeAll,
    TEMU_PDP_FALLBACK_LABELS.seeAllDimensions,
    TEMU_PDP_FALLBACK_LABELS.seeMore,
    TEMU_PDP_FALLBACK_LABELS.seeMoreProductDetails,
    TEMU_PDP_FALLBACK_LABELS.seeMoreProperties,
  ];
  return new Set(values.map((label) => label.toLowerCase()));
}

/** True when the element is a collapse control (by label or visible text). */
function isCollapseControl(el: Element, controls: Set<string>): boolean {
  const aria = cleanTemuText(el.getAttribute('aria-label'));
  if (aria && controls.has(aria.toLowerCase())) return true;
  const text = cleanTemuText(el.textContent);
  return Boolean(text && controls.has(text.toLowerCase()));
}

/**
 * Text of the labelled rows inside one module block.
 *
 * Takes the **outermost** labelled element per row: `DescriptionV2` nests a
 * copy button that also carries an `aria-label`, and the row (not the button)
 * is the datum. Temu appends ". Open in new tab." to linked rows and prefixes
 * DescriptionV2 labels with `$`; both are stripped here.
 */
function moduleRowTexts(
  block: Element,
  controls: Set<string>
): string[] {
  const rows: string[] = [];
  for (const el of Array.from(block.querySelectorAll('[aria-label]'))) {
    const labelledAncestor = el.parentElement?.closest('[aria-label]');
    if (labelledAncestor && block.contains(labelledAncestor)) continue;

    const label = cleanTemuText(el.getAttribute('aria-label'));
    if (!label) continue;

    const text = label
      .replace(/^\$/, '')
      .replace(/\.\s*Open in new tab\.$/i, '')
      .trim();
    if (!text || controls.has(text.toLowerCase())) continue;
    rows.push(text);
  }
  return rows;
}

/**
 * The `goodsProperty` list: the largest container under the details section
 * whose direct `div` children are **all** `Key: value` rows.
 *
 * Requiring every child to match is what keeps compliance warnings, the
 * "Report this item" entry and unrelated prose out of `features`.
 */
function propertyRows(root: Element): string[] {
  let best: string[] = [];

  for (const el of Array.from(root.querySelectorAll('div'))) {
    if (
      el.closest(
        `${TEMU_SELECTORS.productDetail.moduleBlock}, table, nav, ul, ol, [role="button"]`
      )
    ) {
      continue;
    }
    const children = Array.from(el.children).filter(
      (child) => child.tagName === 'DIV'
    );
    if (children.length < 3) continue;

    const rows: string[] = [];
    for (const child of children) {
      const text = cleanTemuText(extractTemuElementText(child));
      if (!text || text.length < 4 || text.length > 200) break;
      if (!KEY_VALUE.test(text)) break;
      rows.push(text);
    }

    if (rows.length === children.length && rows.length > best.length) {
      best = rows;
    }
  }

  return best;
}

/** `GoodsPropertyTable` rows, joined as `Key: Value`. */
function propertyTableRows(root: Element): string[] {
  const rows: string[] = [];
  for (const tr of Array.from(
    root.querySelectorAll(TEMU_SELECTORS.productDetail.propertyTable)
  )) {
    const key = cleanTemuText(tr.querySelector('th')?.textContent);
    const value = cleanTemuText(tr.querySelector('td')?.textContent);
    if (key && value) rows.push(`${key}: ${value}`);
  }
  return rows;
}

/**
 * Extracts `features` from the product-details section.
 *
 * Sources, in order: module rows inside `#goodsDetail` (Highlights),
 * `Key: value` property rows, the extended-property table. The right column's
 * Highlights module is used only when the details section yields nothing.
 */
export function extractTemuPdpFeatures(
  doc: Document,
  labels: TemuPdpLabels = TEMU_PDP_FALLBACK_LABELS
): FeatureEvidence {
  const details = doc.querySelector(TEMU_SELECTORS.productDetail.detailsSection);
  const controls = controlLabels(labels);
  const seen = new Set<string>();
  const out: string[] = [];
  let candidates = 0;

  const push = (raw: string | null): void => {
    const text = cleanTemuText(raw);
    if (!text) return;
    candidates += 1;
    if (text.length < 4 || text.length > 200) return;
    const key = text.split(':', 1)[0]!.trim().toLowerCase();
    if (FEATURE_KEY_DENYLIST.has(key)) return;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey) || out.length >= MAX_FEATURES) return;
    seen.add(dedupeKey);
    out.push(text);
  };

  if (details) {
    for (const block of Array.from(
      details.querySelectorAll(TEMU_SELECTORS.productDetail.moduleBlock)
    )) {
      moduleRowTexts(block, controls).forEach(push);
    }
    propertyRows(details).forEach(push);
    propertyTableRows(details).forEach(push);
  }

  const collapsed = details ? hasCollapsedControl(details, controls) : false;
  if (out.length > 0) {
    return { features: out, collapsed, candidates, source: 'details-section' };
  }

  const right = doc.querySelector(
    TEMU_SELECTORS.productDetail.descriptionRegion
  );
  const highlight = right
    ? Array.from(
        right.querySelectorAll(TEMU_SELECTORS.productDetail.moduleBlock)
      ).find(
        (block) =>
          cleanTemuText(extractTemuElementText(block.firstElementChild)) ===
          labels.highlight
      )
    : undefined;
  if (highlight) moduleRowTexts(highlight, controls).forEach(push);

  return {
    features: out,
    collapsed,
    candidates,
    source: out.length > 0 ? 'right-column-highlights' : 'none',
  };
}

/**
 * Extracts `description` from the page's own "Description" module.
 *
 * Matched by localised title first, then by DescriptionV2's structural
 * signature (`aria-label="$…"`) so a missing i18n store does not lose the
 * field. `meta[name="description"]` is deliberately not a source: on Temu it
 * is SEO boilerplate, not the product's description.
 */
export function extractTemuPdpDescription(
  doc: Document,
  labels: TemuPdpLabels = TEMU_PDP_FALLBACK_LABELS
): DescriptionEvidence {
  const right = doc.querySelector(
    TEMU_SELECTORS.productDetail.descriptionRegion
  );
  if (!right) {
    return { description: null, source: 'none', collapsed: false, candidates: 0 };
  }

  const controls = controlLabels(labels);
  const blocks = Array.from(
    right.querySelectorAll(TEMU_SELECTORS.productDetail.moduleBlock)
  );
  const byTitle = blocks.find(
    (block) =>
      cleanTemuText(extractTemuElementText(block.firstElementChild)) ===
      labels.description
  );
  const bySignature = blocks.find((block) =>
    block.querySelector('[aria-label^="$"]')
  );
  const chosen = byTitle ?? bySignature;
  if (!chosen) {
    return { description: null, source: 'none', collapsed: false, candidates: 0 };
  }

  const rows = moduleRowTexts(chosen, controls);
  return {
    description: rows.length > 0 ? rows.join(DESCRIPTION_SEPARATOR) : null,
    source: rows.length > 0 ? 'description-module' : 'none',
    collapsed: hasCollapsedControl(chosen, controls),
    candidates: rows.length,
  };
}

function hasCollapsedControl(scope: Element, controls: Set<string>): boolean {
  return Array.from(
    scope.querySelectorAll('[role="button"], button')
  ).some((el) => isCollapseControl(el, controls));
}

/**
 * Expands collapsed detail rows so the next parse can read the whole list.
 *
 * Opt-in (settings.expandProductDetails, default off): clicking mutates the
 * user's page. Bounded to the two PDP containers and never throws; the caller
 * re-parses afterwards, so a click that does not change anything is harmless.
 *
 * @returns how many controls were clicked.
 */
export function expandTemuDetailSections(
  doc: Document,
  labels: TemuPdpLabels = TEMU_PDP_FALLBACK_LABELS
): number {
  const controls = controlLabels(labels);
  let clicked = 0;

  for (const scope of [
    TEMU_SELECTORS.productDetail.detailsSection,
    TEMU_SELECTORS.productDetail.descriptionRegion,
  ]) {
    const root = doc.querySelector(scope);
    if (!root) continue;
    for (const el of Array.from(
      root.querySelectorAll('[role="button"], button')
    )) {
      if (!isCollapseControl(el, controls)) continue;
      try {
        (el as HTMLElement).click();
        clicked += 1;
      } catch {
        // Detached or inert node: skip it, never fail the collection.
      }
    }
  }

  return clicked;
}
