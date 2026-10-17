import type { AmazonPageType } from '@/types/common';

/**
 * Detects which type of Amazon page the content script is running on.
 * Returns one of: 'search', 'product-detail', 'category', 'bestsellers', 'unknown'.
 */
export function detectPageType(
  url: string,
  document: Document
): AmazonPageType {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const searchParams = parsedUrl.searchParams;

    // Product detail: /dp/<ASIN>, /gp/product/<ASIN>, /gp/aw/d/<ASIN>, /product/<ASIN>
    if (
      /\/dp\/[A-Z0-9]{10}/i.test(pathname) ||
      /\/gp\/product\/[A-Z0-9]{10}/i.test(pathname) ||
      /\/gp\/aw\/d\/[A-Z0-9]{10}/i.test(pathname) ||
      /\/product\/[A-Z0-9]{10}/i.test(pathname)
    ) {
      return 'product-detail';
    }

    // Search results: /s?k=... or /s?i=... or /s/ref=...
    if (pathname === '/s' || pathname.startsWith('/s/')) {
      if (
        searchParams.has('k') ||
        searchParams.has('i') ||
        searchParams.has('rh') ||
        searchParams.has('field-keywords')
      ) {
        return 'search';
      }
      if (document.querySelector('[data-component-type="s-search-result"]')) {
        return 'search';
      }
    }

    // Bestsellers / New Releases / Movers & Shakers / Most Wished For
    if (
      pathname.startsWith('/Best-Sellers') ||
      pathname.includes('bestsellers') ||
      pathname.includes('/gp/new-releases') ||
      pathname.includes('/gp/movers-and-shakers') ||
      pathname.includes('/gp/most-wished-for')
    ) {
      return 'bestsellers';
    }

    // Category / browse / deals pages (/b/..., /deals, /gp/goldbox, /b?node=..., or #departments)
    if (
      pathname === '/b' ||
      pathname.startsWith('/b/') ||
      pathname === '/deals' ||
      pathname.startsWith('/deals/') ||
      pathname.includes('/goldbox') ||
      pathname.startsWith('/primeday') ||
      pathname.startsWith('/events/') ||
      searchParams.has('node') ||
      document.querySelector('#departments') ||
      document.querySelector(
        '.zg-grid-general-faceout, #gridItemRoot, [data-testid="grid-deals-container"], [data-testid="deal-card"], [data-testid="product-card"]'
      )
    ) {
      return 'category';
    }

    // Fallback: check for search results grid in DOM
    if (document.querySelector('[data-component-type="s-search-result"]')) {
      return 'search';
    }

    // Fallback: check for product detail elements
    if (document.querySelector('#productTitle')) {
      return 'product-detail';
    }

    // Fallback: check for category/grid cards with data-asin
    if (document.querySelector('.octopus-pc-item, .p13n-sc-uncoverable-faceout')) {
      return 'category';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}
