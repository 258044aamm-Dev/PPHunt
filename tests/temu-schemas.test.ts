import { describe, expect, it } from 'vitest';
import {
  isTemuUrl,
  normalizeGoodsId,
  extractGoodsId,
  buildCanonicalTemuUrl,
  resolveTemuProductUrl,
  detectTemuPageTypeFromUrl,
  extractTemuSearchQueryFromUrl,
} from '@/engines/temu/utils/temu-url';
import {
  detectTemuCurrency,
  parseTemuPrice,
  parseTemuSplitPrice,
  normalizeTemuSalesText,
} from '@/engines/temu/utils/price-parser';
import { TemuProductSchema } from '@/engines/temu/schemas/product';
import { TemuScrapedProductSchema } from '@/engines/temu/schemas/scraped-product';
import { TemuSettingsSchema } from '@/engines/temu/schemas/settings';
import {
  TemuExtensionMessageSchema,
  TemuSidepanelIncomingMessageSchema,
} from '@/engines/temu/schemas/messages';
import {
  isTemuMessage,
  validateTemuBackgroundIncomingMessage,
  validateTemuContentIncomingMessage,
  validateTemuSidepanelIncomingMessage,
} from '@/engines/temu/schemas/validate-message';

describe('Temu URL & GoodsId utilities (SAD-209 / SAD-222)', () => {
  it('detects valid Temu HTTP(S) URLs and rejects non-Temu or non-HTTP URLs', () => {
    expect(isTemuUrl('https://www.temu.com/womens-shoes-o3-95.html')).toBe(true);
    expect(isTemuUrl('https://temu.com/goods.html?goods_id=601099769178067')).toBe(true);
    expect(isTemuUrl('https://us.temu.com/search_result.html?search_key=earbuds')).toBe(true);
    expect(isTemuUrl('https://www.amazon.com/dp/B08N5WRWNW')).toBe(false);
    expect(isTemuUrl('https://evil-temu.com/goods.html?goods_id=601099769178067')).toBe(false);
    expect(isTemuUrl('chrome://extensions')).toBe(false);
    expect(isTemuUrl('')).toBe(false);
  });

  it('extracts numeric goodsId from SEO slugs, query params, and data-tooltip identifiers', () => {
    expect(
      extractGoodsId(
        'https://www.temu.com/wireless-bluetooth-earbuds-g-601099769178067.html?_oak_mp_inf=123'
      )
    ).toBe('601099769178067');
    expect(
      extractGoodsId(
        'https://www.temu.com/goods.html?goods_id=601099512345678&refer_page_name=search_result'
      )
    ).toBe('601099512345678');
    expect(
      extractGoodsId('/portable-blender-g-601099888777666.html')
    ).toBe('601099888777666');
    expect(extractGoodsId('goodContainer-601099769178067')).toBe(
      '601099769178067'
    );
    expect(extractGoodsId('goodName-601099769178067')).toBe(
      '601099769178067'
    );
    expect(normalizeGoodsId('601099769178067')).toBe('601099769178067');
    expect(normalizeGoodsId('B08N5WRWNW')).toBeNull();
    expect(normalizeGoodsId('123')).toBeNull();
  });

  it('builds canonical Temu product URLs and classifies URL page types', () => {
    expect(
      resolveTemuProductUrl(
        '/wireless-earbuds-g-601099769178067.html?_oak_mp_inf=abc&top_gallery_url=xyz',
        '601099769178067',
        'https://www.temu.com/search_result.html?search_key=earbuds'
      )
    ).toBe('https://www.temu.com/wireless-earbuds-g-601099769178067.html');

    expect(buildCanonicalTemuUrl('601099769178067')).toBe(
      'https://www.temu.com/goods.html?goods_id=601099769178067'
    );

    expect(
      detectTemuPageTypeFromUrl(
        'https://www.temu.com/search_result.html?search_key=earbuds'
      )
    ).toBe('search');
    expect(
      detectTemuPageTypeFromUrl(
        'https://www.temu.com/flat-wireless-earbuds-5030186936120-s.html'
      )
    ).toBe('search');
    expect(
      detectTemuPageTypeFromUrl('https://www.temu.com/womens-shoes-o3-95.html')
    ).toBe('category');
    expect(
      detectTemuPageTypeFromUrl(
        'https://www.temu.com/wireless-earbuds-g-601099769178067.html'
      )
    ).toBe('product_detail');
    expect(
      extractTemuSearchQueryFromUrl(
        'https://www.temu.com/search_result.html?search_key=wireless+earbuds'
      )
    ).toBe('wireless earbuds');
  });
});

describe('Temu price and sales parsers', () => {
  it('parses US dollar prices, split prices, and sales text without fabricating values', () => {
    expect(parseTemuPrice('$12.49')).toEqual({ value: 12.49, currency: 'USD' });
    expect(parseTemuPrice('US$ 1,249.00')).toEqual({
      value: 1249,
      currency: 'USD',
    });
    expect(parseTemuPrice('-68%')).toEqual({ value: null, currency: null });
    expect(parseTemuPrice('Free shipping')).toEqual({
      value: null,
      currency: null,
    });
    expect(parseTemuSplitPrice('8', '48', '$')).toEqual({
      value: 8.48,
      currency: 'USD',
    });
    expect(detectTemuCurrency('$19.99')).toBe('USD');
    expect(normalizeTemuSalesText('10K+ sold')).toBe('10K+ sold');
    expect(normalizeTemuSalesText('428 sold in past month')).toBe(
      '428 sold in past month'
    );
    expect(normalizeTemuSalesText('In Stock')).toBeNull();
  });
});

describe('Temu Zod schemas & message validation (SAD-210 / SAD-222)', () => {
  it('validates complete and sparse TemuProduct records without fabricating missing fields', () => {
    const validProduct = {
      goodsId: '601099769178067',
      asin: '601099769178067',
      title: 'Wireless Bluetooth 5.3 Earbuds with LED Display',
      price: 8.48,
      listPrice: 24.99,
      discountPercentage: '66% off',
      currency: 'USD',
      rating: 4.8,
      reviewCount: 2341,
      pastMonthSales: '10K+ sold',
      badge: 'Best Seller',
      dealBadge: 'Lightning deal',
      bestSellersRank: '#1 Best Seller in Audio',
      coupon: null,
      delivery: 'Free shipping',
      imageUrl: 'https://img.kwcdn.com/product/fancy/earbuds.jpg',
      url: 'https://www.temu.com/wireless-earbuds-g-601099769178067.html',
      isSponsored: false,
      isPrime: true,
      brand: null,
      availability: 'Almost sold out',
      seller: 'SoundWave Official',
      description: null,
      features: [],
      collectedAt: '2026-10-17T12:00:00.000Z',
      source: 'search' as const,
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    };

    const parsed = TemuProductSchema.safeParse(validProduct);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.goodsId).toBe('601099769178067');
      expect(parsed.data.asin).toBe('601099769178067');
      expect(parsed.data.brand).toBeNull();
      expect(parsed.data.coupon).toBeNull();
    }

    // Sparse scraped product with missing price, rating, reviews, brand, seller
    const sparseScraped = TemuScrapedProductSchema.safeParse({
      goodsId: '601099769178067',
      asin: '601099769178067',
      title: 'Minimalist Ceramic Coffee Mug',
      price: null,
      listPrice: null,
      discountPercentage: null,
      dealBadge: null,
      currency: 'USD',
      rating: null,
      reviewCount: null,
      bestSellersRank: null,
      pastMonthSales: null,
      coupon: null,
      badge: null,
      delivery: null,
      imageUrl: null,
      url: 'https://www.temu.com/goods.html?goods_id=601099769178067',
      isSponsored: false,
      isPrime: false,
      brand: null,
      availability: null,
      seller: null,
      description: null,
      features: [],
      source: 'category',
    });
    expect(sparseScraped.success).toBe(true);
    if (sparseScraped.success) {
      expect(sparseScraped.data.price).toBeNull();
      expect(sparseScraped.data.rating).toBeNull();
      expect(sparseScraped.data.reviewCount).toBeNull();
      expect(sparseScraped.data.brand).toBeNull();
    }
  });

  it('rejects invalid goodsId, out-of-range rating, and negative prices', () => {
    const valid = {
      goodsId: '601099769178067',
      asin: '601099769178067',
      title: 'Valid Temu Product',
      price: 9.99,
      currency: 'USD',
      rating: 4.5,
      reviewCount: 10,
      imageUrl: null,
      url: 'https://www.temu.com/goods.html?goods_id=601099769178067',
      isSponsored: false,
      isPrime: false,
      brand: null,
      availability: null,
      seller: null,
      description: null,
      features: [],
      collectedAt: '2026-10-17T12:00:00.000Z',
      source: 'search' as const,
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    };

    expect(TemuProductSchema.safeParse(valid).success).toBe(true);
    expect(
      TemuProductSchema.safeParse({ ...valid, goodsId: 'NOT-NUMERIC' }).success
    ).toBe(false);
    expect(
      TemuProductSchema.safeParse({ ...valid, rating: 6.2 }).success
    ).toBe(false);
  });

  it('hydrates TemuSettingsSchema defaults and enforces bounds', () => {
    const hydrated = TemuSettingsSchema.parse({});
    expect(hydrated.defaultMode).toBe('automatic');
    expect(hydrated.defaultTargetCount).toBe(50);
    expect(hydrated.defaultExportColumns).toContain('asin');
    expect(hydrated.defaultExportColumns).toContain('title');

    expect(
      TemuSettingsSchema.safeParse({
        defaultTargetCount: 150,
        scrollSpeed: 'fast',
      }).success
    ).toBe(true);

    expect(
      TemuSettingsSchema.safeParse({
        defaultTargetCount: 99999,
      }).success
    ).toBe(false);
  });

  it('identifies TEMU_* messages via isTemuMessage() and rejects Amazon messages', () => {
    expect(
      isTemuMessage({
        type: 'TEMU_START_COLLECTION',
        payload: { mode: 'manual', targetCount: 50, tabId: 10 },
      })
    ).toBe(true);
    expect(isTemuMessage({ type: 'START_COLLECTION', payload: {} })).toBe(false);
    expect(isTemuMessage(null)).toBe(false);

    const startMsg = validateTemuBackgroundIncomingMessage({
      type: 'TEMU_START_COLLECTION',
      payload: { mode: 'automatic', targetCount: 100, tabId: 12 },
    });
    expect(startMsg).not.toBeNull();
    expect(startMsg?.type).toBe('TEMU_START_COLLECTION');

    const contentCmd = validateTemuContentIncomingMessage({
      type: 'TEMU_COLLECT_PRODUCTS',
      payload: {
        mode: 'manual',
        targetCount: 50,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
    });
    expect(contentCmd).not.toBeNull();

    const progressValidation = validateTemuSidepanelIncomingMessage({
      type: 'TEMU_COLLECTION_PROGRESS',
      payload: {
        collectedCount: 25,
        targetCount: 100,
        status: 'collecting',
        scrollCount: 3,
      },
    });
    expect(progressValidation).not.toBeNull();
    expect(
      TemuSidepanelIncomingMessageSchema.safeParse({
        type: 'TEMU_COLLECTION_STATUS',
        payload: {
          status: 'completed',
          collectedCount: 50,
          targetCount: 50,
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
        },
      }).success
    ).toBe(true);

    expect(
      TemuExtensionMessageSchema.safeParse({
        type: 'START_COLLECTION',
        payload: { mode: 'manual', targetCount: 50 },
      }).success
    ).toBe(false);
  });
});
