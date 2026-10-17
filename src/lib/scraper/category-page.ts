import { extractCardPricingAndDiscounts } from '@/lib/scraper/field-parsers';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import {
  parseAmazonCategoryPage,
  type CategoryPageParseOptions,
} from '@/engines/amazon/scraper/category-page';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';

export function parseCategoryPage(
  doc: Document = document,
  pageUrl?: string,
  pageTypeOrCacheOrOptions?:
    | string
    | AmazonParseCache
    | CategoryPageParseOptions,
  explicitCache?: AmazonParseCache,
): ScrapedAmazonProduct[] {
  const baseOptions: CategoryPageParseOptions =
    pageTypeOrCacheOrOptions instanceof AmazonParseCache
      ? { cache: pageTypeOrCacheOrOptions }
      : typeof pageTypeOrCacheOrOptions === 'string'
        ? { cache: explicitCache }
        : { ...(pageTypeOrCacheOrOptions ?? {}) };

  if (explicitCache && !baseOptions.cache) {
    baseOptions.cache = explicitCache;
  }

  return parseAmazonCategoryPage(doc, pageUrl, {
    ...baseOptions,
    extractPricing:
      baseOptions.extractPricing ?? extractCardPricingAndDiscounts,
  });
}
