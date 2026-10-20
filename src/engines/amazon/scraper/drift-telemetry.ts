import type { AmazonDriftReport, AmazonExtractionTier } from '../types';
import { getDiagnosticsEnabled } from '../utils/diagnostics-flag';

export type AmazonTrackedField =
  | 'asin'
  | 'title'
  | 'price'
  | 'rating'
  | 'reviewCount'
  | 'imageUrl';

const TRACKED_FIELDS: readonly AmazonTrackedField[] = [
  'asin',
  'title',
  'price',
  'rating',
  'reviewCount',
  'imageUrl',
];

/**
 * Local DOM-Drift & Tier-Fallback Telemetry tracker.
 * Tracks which tier of the 4-tier self-healing extraction cascade resolved each field
 * and detects partial DOM drift when Amazon updates page layouts or A/B tests selectors.
 */
export class AmazonDriftTelemetry {
  private cardsInspected = 0;
  private cardsExtracted = 0;
  private fieldHitCounts: Record<AmazonTrackedField, number> = {
    asin: 0,
    title: 0,
    price: 0,
    rating: 0,
    reviewCount: 0,
    imageUrl: 0,
  };
  private tierBreakdown: Record<AmazonExtractionTier, number> = {
    tier1_json: 0,
    tier2_semantic: 0,
    tier3_structural: 0,
    tier4_selector: 0,
    missing: 0,
  };
  private structuralTitleOrAsinHits = 0;

  recordCard(
    fieldTiers: Partial<Record<AmazonTrackedField, AmazonExtractionTier>>,
    extracted: boolean,
  ): void {
    this.cardsInspected += 1;
    if (extracted) {
      this.cardsExtracted += 1;
    }

    for (const field of TRACKED_FIELDS) {
      const tier = fieldTiers[field] ?? 'missing';
      this.tierBreakdown[tier] += 1;
      if (tier !== 'missing' && extracted) {
        this.fieldHitCounts[field] += 1;
      }
    }

    if (
      extracted &&
      (fieldTiers.asin === 'tier3_structural' ||
        fieldTiers.title === 'tier3_structural')
    ) {
      this.structuralTitleOrAsinHits += 1;
    }
  }

  recordCardExtraction(
    fieldTiers: Partial<Record<AmazonTrackedField, AmazonExtractionTier>>,
  ): void {
    this.recordCard(fieldTiers, true);
  }

  reset(): void {
    this.cardsInspected = 0;
    this.cardsExtracted = 0;
    for (const field of TRACKED_FIELDS) {
      this.fieldHitCounts[field] = 0;
    }
    this.tierBreakdown = {
      tier1_json: 0,
      tier2_semantic: 0,
      tier3_structural: 0,
      tier4_selector: 0,
      missing: 0,
    };
    this.structuralTitleOrAsinHits = 0;
  }

  getReport(): AmazonDriftReport {
    const denom = this.cardsExtracted > 0 ? this.cardsExtracted : 1;
    const roundRatio = (count: number) =>
      this.cardsExtracted === 0
        ? 0
        : Math.min(1, Math.round((count / denom) * 100) / 100);

    const fieldCoverage = {
      asin: roundRatio(this.fieldHitCounts.asin),
      title: roundRatio(this.fieldHitCounts.title),
      price: roundRatio(this.fieldHitCounts.price),
      rating: roundRatio(this.fieldHitCounts.rating),
      reviewCount: roundRatio(this.fieldHitCounts.reviewCount),
      imageUrl: roundRatio(this.fieldHitCounts.imageUrl),
    };

    const driftReasons: string[] = [];

    if (this.cardsInspected > 0 && this.cardsExtracted === 0) {
      driftReasons.push(
        `Inspected ${this.cardsInspected} candidate product containers but 0 valid products had both ASIN and title.`,
      );
    } else if (this.cardsExtracted >= 3) {
      if (fieldCoverage.price < 0.2) {
        driftReasons.push(
          `Low price field coverage (${Math.round(fieldCoverage.price * 100)}%) across ${this.cardsExtracted} extracted cards.`,
        );
      }
      if (fieldCoverage.imageUrl < 0.5) {
        driftReasons.push(
          `Low image URL coverage (${Math.round(fieldCoverage.imageUrl * 100)}%) across ${this.cardsExtracted} extracted cards.`,
        );
      }
      if (this.structuralTitleOrAsinHits / this.cardsExtracted >= 0.75) {
        driftReasons.push(
          'Over 75% of cards required Tier 3 structural /dp/<ASIN> recovery (Amazon semantic attributes may have changed on this layout).',
        );
      }
    }

    return {
      cardsInspected: this.cardsInspected,
      cardsExtracted: this.cardsExtracted,
      fieldCoverage,
      tierBreakdown: { ...this.tierBreakdown },
      isDriftDetected: driftReasons.length > 0,
      driftReasons,
    };
  }
}

export function createAmazonDriftTelemetry(): AmazonDriftTelemetry {
  return new AmazonDriftTelemetry();
}

export const defaultAmazonDriftTelemetry = new AmazonDriftTelemetry();

/**
 * SAD-359: makes the previously consumer-less drift report visible.
 *
 * The telemetry object remains cumulative (this helper deliberately does not
 * reset it), so the line describes the content-script session so far for the
 * telemetry instance used by that parse. It is emitted in the parsing context
 * (the Amazon page console for listing collection), as one-line JSON that can
 * be filtered with `[PPHunt][Amazon][Diagnostics]` and survives copy-paste.
 * The `drift` tag separates it from the per-field report, which is logged by
 * the service worker. No product values or page data are included. A logging
 * failure is swallowed: telemetry must never affect extraction.
 */
export function logDriftReport(
  telemetry: AmazonDriftTelemetry,
  stage: 'search-results' | 'category-page',
): void {
  try {
    // SAD-369: the diagnostics are opt-in; the cached read fails closed, so
    // an unresolved or absent switch prints nothing.
    if (!getDiagnosticsEnabled()) return;
    const report = telemetry.getReport();
    if (report.cardsInspected === 0) return;
    console.info(
      `[PPHunt][Amazon][Diagnostics] drift ${JSON.stringify({ stage, ...report })}`,
    );
  } catch {
    // Diagnostics only.
  }
}

