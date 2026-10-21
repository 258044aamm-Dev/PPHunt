/**
 * SAD-369 step 2 (E5): the per-card field-diagnostics recorder shared by the
 * search-card and category-card parsers.
 *
 * Why one shared function? `parseAmazonSearchCard` and
 * `parseAmazonCategoryCard` are two separate, near-identical implementations —
 * writing the recording calls twice would duplicate ~60 lines that would
 * drift apart.
 *
 * Two rules enforced here (plan §6.1):
 * 1. `EXTRACTED` means a value was obtained; `MISSING` means we looked and it
 *    was not there — every `MISSING` carries a reason saying what was looked
 *    for.
 * 2. A card report carries `tier`, not `selector` — the card extractors work
 *    as a 4-tier cascade, so the tier is the honest "how did we get this"
 *    signal. (`url` → source 'url', `isPrime` → source 'derived', mirroring
 *    the product-detail stage conventions in `product-detail.ts`.)
 */
import type { AmazonExtractionTier } from '../types';
import type {
  ExtractionDiagnosticsReport,
  ExtractionDiagnosticsSink,
  FieldDiagnosticsCollector,
} from './extraction-diagnostics';
import type { CardPricingAndDiscounts, TieredValue } from './field-parsers';

/** The 4 modelled fields a listing card can never carry (SAD-369 D4). */
export const CARD_INAPPLICABLE_FIELDS = [
  'description',
  'features',
  'weight',
  'warrantyDescription',
] as const;

export const CARD_INAPPLICABLE_REASON =
  'not available on a listing card — this field is only extracted from the product page';

/** The already-computed extraction results of ONE card. Nothing here re-parses. */
export interface CardDiagnosticsInput {
  asin: { value: string; tier: AmazonExtractionTier };
  title: { value: string; tier: AmazonExtractionTier };
  brand: string | null;
  pricing: CardPricingAndDiscounts;
  // SAD-383: `TieredValue` so `nodeSeen` (did a node exist at all?) reaches the
  // report. Optional on the type, so every existing caller still compiles.
  rating: TieredValue<number | null>;
  reviewCount: TieredValue<number | null>;
  image: { value: string | null; tier: AmazonExtractionTier };
  pastMonthSales?: string;
  delivery?: string;
  availability: string | null;
  seller: string | null;
  isPrime: boolean;
  bestSellersRank?: string;
  variations?: string | null;
  url: string | null;
}

/**
 * Records all 24 modelled fields from the card parser's already-computed
 * results. The caller invokes this only when the parse produced a product:
 * no report is emitted when the parser returns `null` (no ASIN/title) — there
 * is no product to ride along with, and an unreconciled report would mislead.
 */
export function recordCardDiagnostics(
  collector: FieldDiagnosticsCollector,
  input: CardDiagnosticsInput,
): void {
  const dom = { source: 'dom' as const };

  // asin and title always exist when the parser got this far: it aborts
  // without them.
  collector.extracted('asin', { ...dom, tier: input.asin.tier });
  collector.extracted('title', { ...dom, tier: input.title.tier });

  // The URL is derived from the resolved ASIN and the marketplace origin —
  // the same convention the detail stage uses.
  if (input.url) {
    collector.extracted('url', { source: 'url' });
  } else {
    collector.missing(
      'url',
      'no product URL could be derived from the ASIN and page origin',
      { source: 'derived' },
    );
  }

  if (input.brand) {
    collector.extracted('brand', dom);
  } else {
    collector.missing('brand', 'no brand text found on the card', dom);
  }

  if (input.pricing.price !== null) {
    collector.extracted('price', { ...dom, tier: input.pricing.priceTier });
  } else if (input.pricing.unparseablePriceTier) {
    // SAD-369 D9: a price node WAS present but its text would not parse —
    // never claim the field was absent when the engine can prove otherwise.
    collector.parseFailed(
      'price',
      'price node present but its text could not be parsed',
      { ...dom, tier: input.pricing.unparseablePriceTier },
    );
  } else {
    collector.missing('price', 'no price node found on the card', dom);
  }

  if (input.pricing.listPrice !== undefined) {
    collector.extracted('listPrice', dom);
  } else {
    collector.missing('listPrice', 'no list price present on the card', dom);
  }

  if (input.pricing.discountPercentage !== undefined) {
    collector.extracted('discountPercentage', dom);
  } else if (input.pricing.unparseableDiscountNode) {
    // SAD-386: a percentage-looking node WAS there and the parser refused it
    // (coupon text, out-of-range, unreadable). Never report that as absence.
    collector.parseFailed(
      'discountPercentage',
      'a percentage node is present but its text is not a product discount (coupon, out of range, or unreadable)',
      dom,
    );
  } else {
    collector.missing(
      'discountPercentage',
      'no discount percentage present on the card',
      dom,
    );
  }

  if (input.pricing.dealBadge !== undefined) {
    // SAD-386: `derived` is a real provenance, not a printed badge.
    collector.extracted(
      'dealBadge',
      input.pricing.dealBadgeDerived ? { source: 'derived' } : dom,
    );
  } else {
    collector.missing('dealBadge', 'no deal badge present on the card', dom);
  }

  if (input.pricing.coupon !== undefined) {
    collector.extracted('coupon', dom);
  } else {
    collector.missing('coupon', 'no coupon present on the card', dom);
  }

  if (input.pricing.currency) {
    collector.extracted('currency', dom);
  } else {
    collector.missing(
      'currency',
      'no price and no marketplace currency context on the card',
      dom,
    );
  }

  // SAD-383: a node that exists but does not parse is a selector/parser defect; a
  // layout that never prints the field is not. The old single reason made those
  // two states indistinguishable in the report.
  if (input.rating.value !== null) {
    collector.extracted('rating', { ...dom, tier: input.rating.tier });
  } else if (input.rating.nodeSeen) {
    collector.missing(
      'rating',
      'rating node present on the card but its text did not parse',
      dom,
    );
  } else {
    collector.missing(
      'rating',
      'this card layout prints no rating node — only the product page carries it',
      dom,
    );
  }

  if (input.reviewCount.value !== null) {
    collector.extracted('reviewCount', {
      ...dom,
      tier: input.reviewCount.tier,
    });
  } else if (input.reviewCount.nodeSeen) {
    collector.missing(
      'reviewCount',
      'review-count node present on the card but its text did not parse',
      dom,
    );
  } else {
    collector.missing(
      'reviewCount',
      'this card layout prints no review-count node — only the product page carries it',
      dom,
    );
  }

  if (input.availability) {
    collector.extracted('availability', dom);
  } else {
    collector.missing('availability', 'no availability text found on the card', dom);
  }

  if (input.delivery !== undefined) {
    collector.extracted('delivery', dom);
  } else {
    collector.missing('delivery', 'no delivery node found on the card', dom);
  }

  if (input.seller) {
    collector.extracted('seller', dom);
  } else {
    collector.missing('seller', 'no seller text found on the card', dom);
  }

  if (input.pastMonthSales !== undefined) {
    collector.extracted('pastMonthSales', dom);
  } else {
    collector.missing(
      'pastMonthSales',
      'no past-month sales text found on the card',
      dom,
    );
  }

  if (input.bestSellersRank !== undefined) {
    collector.extracted('bestSellersRank', dom);
  } else {
    collector.missing(
      'bestSellersRank',
      'no best sellers rank text found on the card',
      dom,
    );
  }

  if (input.image.value !== null) {
    collector.extracted('imageUrl', { ...dom, tier: input.image.tier });
  } else {
    collector.missing('imageUrl', 'no product image found on the card', dom);
  }

  if (input.variations) {
    collector.extracted('variations', dom);
  } else {
    collector.missing('variations', 'no variations control found on the card', dom);
  }

  // A derived boolean, not a DOM node — the detail-stage convention.
  if (input.isPrime) {
    collector.extracted('isPrime', { source: 'derived' });
  } else {
    collector.missing('isPrime', 'no Prime marker found', {
      source: 'derived',
    });
  }

  // D4: the 4 fields a listing card can never carry. MISSING *with a reason*
  // — the engine can establish that a card does not carry them, and the
  // reason is what tells a reader this is normal, not a fault.
  for (const field of CARD_INAPPLICABLE_FIELDS) {
    collector.missing(field, CARD_INAPPLICABLE_REASON);
  }
}

/**
 * A sink that captures exactly the first report — used by the two card save
 * paths, where exactly one card is parsed (`extractProductFromCard` tries the
 * search parser first; a failed search parse emits no report, so the category
 * parse emits the one report).
 */
export function createSingleReportSink(): ExtractionDiagnosticsSink & {
  report?: ExtractionDiagnosticsReport;
} {
  const sink = {
    report: undefined as ExtractionDiagnosticsReport | undefined,
    accept(report: ExtractionDiagnosticsReport): void {
      sink.report ??= report; // first report wins
    },
  };
  return sink;
}
