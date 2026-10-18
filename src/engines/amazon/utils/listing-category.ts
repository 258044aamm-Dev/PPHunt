import type { AmazonListingCategory, ScrapedAmazonProduct } from '../types/product';

export type ListingCategoryFilter = 'all' | AmazonListingCategory;

export interface ProductListingInput {
  isSponsored?: boolean;
  listingCategory?: AmazonListingCategory;
  sectionLabel?: string | null;
  placements?: string[];
}

/**
 * Resolves the primary 3-way listing category (`organic` | `sponsored` | `recommendation`)
 * for an Amazon product record.
 */
export function resolveListingCategory(
  product: ProductListingInput | null | undefined,
): AmazonListingCategory {
  if (!product) return 'organic';
  if (
    product.listingCategory === 'organic' ||
    product.listingCategory === 'sponsored' ||
    product.listingCategory === 'recommendation'
  ) {
    return product.listingCategory;
  }
  return product.isSponsored ? 'sponsored' : 'organic';
}

/**
 * Resolves a human-readable category badge title (`Organic` | `Sponsored` | `Recommendation`).
 */
export function formatListingCategoryLabel(
  category: AmazonListingCategory,
): string {
  switch (category) {
    case 'sponsored':
      return 'Sponsored';
    case 'recommendation':
      return 'Recommendation';
    case 'organic':
    default:
      return 'Organic';
  }
}

/**
 * Resolves a descriptive placement string for a product (e.g. `"Organic Search"`,
 * `"Sponsored Brand"`, `"Sponsored Video"`, `"People Also View"`, `"Highly rated by customers"`).
 */
export function resolvePlacementLabel(
  product: ProductListingInput | null | undefined,
): string {
  if (!product) return 'Organic Search';
  const section = product.sectionLabel?.trim();
  if (section) {
    return section;
  }
  const category = resolveListingCategory(product);
  if (category === 'recommendation') return 'Recommendation';
  if (category === 'sponsored') return 'Sponsored Search';
  return 'Organic Search';
}

/**
 * Returns all distinct placements where this product appeared on the page.
 */
export function resolveProductPlacements(
  product: ProductListingInput | null | undefined,
): string[] {
  if (!product) return ['Organic Search'];
  if (Array.isArray(product.placements) && product.placements.length > 0) {
    return product.placements;
  }
  return [resolvePlacementLabel(product)];
}

function classifyPlacementString(placement: string): AmazonListingCategory {
  const normalized = placement.toLowerCase();
  if (normalized.includes('sponsored')) {
    return 'sponsored';
  }
  if (normalized === 'organic search' || normalized === 'organic') {
    return 'organic';
  }
  return 'recommendation';
}

/**
 * Checks whether a product matches the active category filter (`all` | `organic` | `sponsored` | `recommendation`),
 * including multi-placement products that appeared in both a widget and main results.
 */
export function matchesListingCategoryFilter(
  product: ProductListingInput | null | undefined,
  filter: ListingCategoryFilter,
): boolean {
  if (filter === 'all') return true;
  if (!product) return false;
  if (resolveListingCategory(product) === filter) {
    return true;
  }
  if (Array.isArray(product.placements) && product.placements.length > 1) {
    return product.placements.some(
      (placement) => classifyPlacementString(placement) === filter,
    );
  }
  return false;
}

/**
 * Counts how many products in a list match each category filter (`all`, `organic`, `sponsored`, `recommendation`).
 */
export function countProductsByListingCategory(
  products: readonly ScrapedAmazonProduct[] | readonly ProductListingInput[],
): Record<ListingCategoryFilter, number> {
  const counts: Record<ListingCategoryFilter, number> = {
    all: products.length,
    organic: 0,
    sponsored: 0,
    recommendation: 0,
  };
  for (const product of products) {
    if (matchesListingCategoryFilter(product, 'organic')) {
      counts.organic += 1;
    }
    if (matchesListingCategoryFilter(product, 'sponsored')) {
      counts.sponsored += 1;
    }
    if (matchesListingCategoryFilter(product, 'recommendation')) {
      counts.recommendation += 1;
    }
  }
  return counts;
}
