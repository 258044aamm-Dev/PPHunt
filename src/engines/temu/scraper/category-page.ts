import type { TemuProductSource, TemuScrapedProduct } from '../types';
import type { TemuParseCache } from './parse-cache';
import { parseTemuSearchResults } from './search-results';

/**
 * Parses all product cards from a Temu category, channel, or bestsellers page
 * (`/*-o3-*.html`, `/*-o2-*.html`, `/channel/*`, `/bestsellers*`).
 *
 * Because Temu's `bui-web-goods-list` renders identical card semantics across
 * search and category pages (`.js-category-goodsList`, `.auto-fit-list`, `[data-tooltip^="goodContainer-"]`),
 * this delegates to the shared 4-layer card extraction pipeline with `source = 'category'`.
 */
export function parseTemuCategoryPage(
  document: Document,
  pageUrl?: string,
  source: TemuProductSource = 'category',
  cache?: TemuParseCache
): TemuScrapedProduct[] {
  return parseTemuSearchResults(document, pageUrl, cache, source);
}
