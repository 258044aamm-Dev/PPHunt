import type { TemuProductSource, TemuScrapedProduct } from '../types';
import { resolveTemuProductUrl } from '../utils/temu-url';
import {
  applyValidationResults,
  createFieldDiagnosticsCollector,
  type ExtractionDiagnosticsReport,
  type TemuDiagnosticStage,
} from './extraction-diagnostics';
import {
  discoverTemuProductCards,
  extractGoodsIdFromCard,
  extractTemuCardMetadata,
  extractTemuCardTitle,
  extractTemuPricing,
  extractTemuRatingAndReviews,
  extractTemuSalesVolume,
  findBestTemuCardImage,
  resolveSingleGoodsCardContainer,
  validateAndNormalizeTemuScrapedProduct,
} from './field-parsers';
import type { TemuParseCache } from './parse-cache';

/**
 * Parses all product cards from a Temu search results page (`/search_result.html` or `/*-s.html`).
 * Uses 4-layer extraction with per-card fault isolation so a malformed card never aborts the batch.
 */
export function parseTemuSearchResults(
  document: Document,
  pageUrl?: string,
  cache?: TemuParseCache,
  source: TemuProductSource = 'search',
  diagnosticsByGoodsId?: Map<string, ExtractionDiagnosticsReport>
): TemuScrapedProduct[] {
  const products: TemuScrapedProduct[] = [];
  const seenGoodsIds = new Set<string>();
  const baseUrl =
    pageUrl ??
    document.location?.href ??
    (typeof window !== 'undefined' ? window.location?.href : undefined) ??
    'https://www.temu.com';

  // Prefer the dedicated search/category listing grid when present so footer/sidebar carousels don't pollute ordering
  const primaryGrid = document.querySelector(
    '.js-search-goodsList, .js-category-goodsList, .auto-fit-list'
  );
  const rawCards = primaryGrid
    ? discoverTemuProductCards(primaryGrid)
    : discoverTemuProductCards(document);

  const cards =
    rawCards.length > 0 ? rawCards : discoverTemuProductCards(document);

  for (const rawCard of cards) {
    try {
      const { goodsId, linkHref } = extractGoodsIdFromCard(rawCard);
      if (!goodsId || seenGoodsIds.has(goodsId)) continue;

      const cached = cache?.get(rawCard);
      if (cached) {
        if (seenGoodsIds.has(cached.goodsId)) continue;
        seenGoodsIds.add(cached.goodsId);
        products.push(cached);
        continue;
      }

      const card = resolveSingleGoodsCardContainer(rawCard, goodsId);
      // SAD-360: a collector exists only when the caller asked for reports.
      const stage: TemuDiagnosticStage =
        source === 'category' ? 'category' : 'search';
      const diag = diagnosticsByGoodsId
        ? createFieldDiagnosticsCollector(stage)
        : undefined;
      diag?.setGoodsId(goodsId);

      const { imageUrl, imageEl } = findBestTemuCardImage(
        card,
        goodsId,
        baseUrl,
        diag
      );
      const title = extractTemuCardTitle(card, imageEl, diag);
      const pricing = extractTemuPricing(card, 'USD', diag);
      const pastMonthSales = extractTemuSalesVolume(card, diag);
      const { rating, reviewCount } = extractTemuRatingAndReviews(card, diag);
      const meta = extractTemuCardMetadata(card, diag);

      if (diag) {
        diag.extracted(
          'url',
          linkHref
            ? { source: 'url', reason: 'resolved from the card product link' }
            : { source: 'derived', reason: 'built from goodsId and page origin' }
        );
        if (pricing.currency === null) {
          diag.missing(
            'currency',
            'no currency token and no price to derive from',
            { source: 'dom' }
          );
        }
      }

      const candidate: TemuScrapedProduct = {
        goodsId,
        asin: goodsId,
        url: resolveTemuProductUrl(linkHref, goodsId, baseUrl),
        title,
        price: pricing.price,
        listPrice: pricing.listPrice,
        discountPercentage: pricing.discountPercentage,
        dealBadge: meta.dealBadge,
        currency: pricing.currency,
        rating,
        reviewCount,
        bestSellersRank: meta.bestSellersRank,
        pastMonthSales,
        coupon: meta.coupon,
        badge: meta.badge,
        delivery: meta.delivery,
        imageUrl,
        isSponsored: meta.isSponsored,
        isPrime: meta.isPrime,
        brand: meta.brand,
        availability: meta.availability,
        seller: meta.seller,
        description: null,
        features: [],
        source,
      };

      const validated = validateAndNormalizeTemuScrapedProduct(
        candidate,
        baseUrl,
        source
      );

      if (validated) {
        if (diag) applyValidationResults(diag, candidate, validated);
        if (diag && diagnosticsByGoodsId) {
          diagnosticsByGoodsId.set(validated.goodsId, diag.build());
        }
        cache?.set(rawCard, validated);
        seenGoodsIds.add(validated.goodsId);
        products.push(validated);
      }
    } catch (err) {
      console.warn('[PPHunt:Temu] Isolated search card parse error:', err);
    }
  }

  return products;
}
