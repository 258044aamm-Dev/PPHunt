import { extractCardPricingAndDiscounts } from '@/lib/scraper/field-parsers';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import {
  parseAmazonSearchResults,
  type SearchResultsParseOptions,
} from '@/engines/amazon/scraper/search-results';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';

export function parseSearchResults(
  doc: Document = document,
  pageUrl?: string,
  pageTypeOrCacheOrOptions?:
    | string
    | AmazonParseCache
    | SearchResultsParseOptions,
  explicitCache?: AmazonParseCache,
): ScrapedAmazonProduct[] {
  const baseOptions: SearchResultsParseOptions =
    pageTypeOrCacheOrOptions instanceof AmazonParseCache
      ? { cache: pageTypeOrCacheOrOptions }
      : typeof pageTypeOrCacheOrOptions === 'string'
        ? { cache: explicitCache }
        : { ...(pageTypeOrCacheOrOptions ?? {}) };

  if (explicitCache && !baseOptions.cache) {
    baseOptions.cache = explicitCache;
  }

  return parseAmazonSearchResults(doc, pageUrl, {
    ...baseOptions,
    extractPricing:
      baseOptions.extractPricing ?? extractCardPricingAndDiscounts,
  });
}
