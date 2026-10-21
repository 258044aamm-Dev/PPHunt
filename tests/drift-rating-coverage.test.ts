/**
 * SAD-383 step 2 — diagnostics must be able to tell three states apart:
 *
 *   1. the card printed a rating and we read it      → EXTRACTED
 *   2. the card printed a rating we could not parse  → drift signal
 *   3. the card prints no rating at all              → honest zero, NOT drift
 *
 * Before this step `rating`/`reviewCount` were tracked, printed, and then ignored
 * by the detector, so the operator's own log showed `rating: 0,
 * isDriftDetected: false` on 154/154 cards (SAD-370 §3.3) — the exact situation a
 * detector exists to catch, reported as healthy.
 *
 * Inputs are real markup captured 2026-10-21 in `docs/plans/SAD-383-fixtures/`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AmazonDriftTelemetry } from '@/engines/amazon/scraper/drift-telemetry';
import {
  extractCardRatingAndReviewsWithTier,
  validateAndNormalizeScrapedProduct,
} from '@/engines/amazon/scraper/field-parsers';
import { createFieldDiagnosticsCollector } from '@/engines/amazon/scraper/extraction-diagnostics';
import { recordCardDiagnostics } from '@/engines/amazon/scraper/card-diagnostics';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'docs', 'plans', 'SAD-383-fixtures', name), 'utf8');

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** A real bestsellers card (`#gridItemRoot`) that prints 4.6 / 142,457. */
function bestsellersCard(): Element {
  const parsed = doc(fixture('bestsellers-card.real.html'));
  const card = parsed.querySelector('#gridItemRoot');
  if (!card) throw new Error('fixture no longer contains a #gridItemRoot card');
  return card;
}

/** A real deals faceout — deliberately carries no rating markup. */
function dealsCard(): Element {
  const parsed = doc(fixture('deals-card.real.html'));
  const card = parsed.querySelector('[data-csa-c-item-type="deal"]');
  if (!card) throw new Error('fixture no longer contains a deal faceout');
  return card;
}

/** The same deals card, but with a rating node whose text cannot be parsed. */
function dealsCardWithUnparseableRating(): Element {
  const card = dealsCard().cloneNode(true) as Element;
  const row = card.ownerDocument.createElement('div');
  row.className = 'a-icon-row';
  row.innerHTML = '<span class="a-icon-alt">rated by verified buyers</span>';
  card.appendChild(row);
  return card;
}

function feed(telemetry: AmazonDriftTelemetry, card: Element, times: number) {
  for (let i = 0; i < times; i += 1) {
    const { rating, reviewCount } = extractCardRatingAndReviewsWithTier(card);
    telemetry.recordCardExtraction(
      {
        asin: 'tier2_semantic',
        title: 'tier2_semantic',
        price: 'tier2_semantic',
        imageUrl: 'tier3_structural',
        rating: rating.tier,
        reviewCount: reviewCount.tier,
      },
      { ratingNode: rating.nodeSeen, reviewNode: reviewCount.nodeSeen },
    );
  }
}

describe('SAD-383 step 2: rating/review coverage is now a signal, not a blind spot', () => {
  it('a layout that prints ratings reports full coverage and no drift', () => {
    const telemetry = new AmazonDriftTelemetry();
    feed(telemetry, bestsellersCard(), 4);

    const report = telemetry.getReport();
    expect(report.fieldCoverage.rating).toBe(1);
    expect(report.fieldCoverage.reviewCount).toBe(1);
    expect(report.isDriftDetected).toBe(false);
  });

  it('a layout with no rating node stays silent — the /deals grid is not drift', () => {
    const telemetry = new AmazonDriftTelemetry();
    feed(telemetry, dealsCard(), 4);

    const report = telemetry.getReport();
    expect(report.fieldCoverage.rating).toBe(0);
    expect(report.isDriftDetected).toBe(false);
    // Nothing may claim the rating parser drifted when there was nothing to parse.
    expect(report.driftReasons.some((r) => r.includes('Rating nodes were present'))).toBe(
      false,
    );
  });

  it('a rating node that does not parse IS reported as drift', () => {
    const telemetry = new AmazonDriftTelemetry();
    feed(telemetry, dealsCardWithUnparseableRating(), 4);

    const report = telemetry.getReport();
    expect(report.fieldCoverage.rating).toBe(0);
    expect(report.isDriftDetected).toBe(true);
    expect(
      report.driftReasons.some((r) => r.includes('Rating nodes were present on 100%')),
    ).toBe(true);
  });

  it('partial degradation is reported with real percentages', () => {
    const telemetry = new AmazonDriftTelemetry();
    seedMixed(telemetry, 3, 1);

    const report = telemetry.getReport();
    expect(report.fieldCoverage.rating).toBe(0.75);
    // 75% coverage is above the threshold: degraded, but not drift.
    expect(report.driftReasons.some((r) => r.includes('Rating nodes were present'))).toBe(
      false,
    );
  });

  it('detects drift once coverage falls below half of the cards that printed a node', () => {
    const telemetry = new AmazonDriftTelemetry();
    seedMixed(telemetry, 1, 3);

    const report = telemetry.getReport();
    expect(report.fieldCoverage.rating).toBe(0.25);
    expect(report.isDriftDetected).toBe(true);
    expect(
      report.driftReasons.some((r) => r.includes('Review-count nodes were present')),
    ).toBe(true);
  });

  it('the card report says which of the two states occurred', () => {
    const good = diagnosisFor(bestsellersCard());
    expect(good.get('rating')?.status).toBe('EXTRACTED');

    const none = diagnosisFor(dealsCard());
    expect(none.get('rating')?.status).toBe('MISSING');
    expect(none.get('rating')?.reason).toContain('prints no rating node');

    const bad = diagnosisFor(dealsCardWithUnparseableRating());
    expect(bad.get('rating')?.status).toBe('MISSING');
    expect(bad.get('rating')?.reason).toContain('did not parse');
  });

  it('an empty telemetry instance still reports zeros rather than NaN', () => {
    const report = new AmazonDriftTelemetry().getReport();
    expect(report.cardsExtracted).toBe(0);
    expect(report.fieldCoverage.rating).toBe(0);
    expect(report.isDriftDetected).toBe(false);
  });
});

/** `ok` cards that carry a rating, `bad` cards whose node does not parse. */
function seedMixed(telemetry: AmazonDriftTelemetry, ok: number, bad: number) {
  const good = bestsellersCard();
  const broken = dealsCardWithUnparseableRating();
  feed(telemetry, good, ok);
  feed(telemetry, broken, bad);
}

function diagnosisFor(card: Element) {
  const collector = createFieldDiagnosticsCollector();
  const { rating, reviewCount } = extractCardRatingAndReviewsWithTier(card);
  const asin =
    card.querySelector('[data-asin]')?.getAttribute('data-asin') ??
    /\/dp\/([A-Z0-9]{10})/.exec(card.innerHTML)?.[1] ??
    'B0FIXTURE01';

  const candidate = { asin, url: `https://www.amazon.com/dp/${asin}` };
  const normalized = validateAndNormalizeScrapedProduct(
    {
      ...candidate,
      title: 'Fixture Card',
      price: 19.99,
      currency: 'USD',
      rating: rating.value,
      reviewCount: reviewCount.value,
      imageUrl: 'https://m.media-amazon.com/images/I/71aaaaaaaL._AC_UL320_.jpg',
      source: 'category',
    },
    candidate.url,
  );

  recordCardDiagnostics(collector, {
    asin: { value: asin, tier: 'tier2_semantic' },
    title: { value: 'Fixture Card', tier: 'tier2_semantic' },
    brand: null,
    pricing: { price: 19.99, currency: 'USD', priceTier: 'tier2_semantic' },
    rating,
    reviewCount,
    image: {
      value: 'https://m.media-amazon.com/images/I/71aaaaaaaL._AC_UL320_.jpg',
      tier: 'tier3_structural',
    },
    availability: null,
    seller: null,
    isPrime: false,
    url: candidate.url,
  });

  const report = collector.build();
  expect(normalized).not.toBeNull();
  return new Map(report.fields.map((field) => [field.field, field]));
}
