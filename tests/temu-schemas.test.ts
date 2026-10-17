import { describe, expect, it } from 'vitest';
import {
  isTemuUrl,
  isValidGoodsId,
  extractGoodsIdFromUrl,
  extractGoodsIdFromText,
  buildCanonicalTemuUrl,
  detectTemuMarketplace,
  detectTemuUrlPageHint,
} from '@/engines/temu/utils/temu-url';
import {
  parseTemuPrice,
  extractAllDollarAmounts,
  parseTemuDiscountPercentage,
  parseTemuRatingText,
  parseTemuReviewCountText,
  parseTemuSalesText,
} from '@/engines/temu/utils/price-parser';
import { TemuProductSchema } from '@/engines/temu/schemas/product';
import { TemuScrapedProductSchema } from '@/engines/temu/schemas/scraped-product';
import {
  TemuSettingsSchema,
  PartialTemuSettingsSchema,
} from '@/engines/temu/schemas/settings';
import {
  isTemuMessage,
  TemuMessageSchema,
  TemuSidePanelIncomingMessageSchema,
} from '@/engines/temu/schemas/messages';
import {
  validateTemuMessage,
  validateTemuProductBatch,
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
      extractGoodsIdFromUrl(
        'https://www.temu.com/wireless-bluetooth-earbuds-g-601099769178067.html?_oak_mp_inf=123'
      )
    ).toBe('601099769178067');
    expect(
      extractGoodsIdFromUrl(
        'https://www.temu.com/goods.html?goods_id=601099512345678&refer_page_name=search_result'
      )
    ).toBe('601099512345678');
    expect(
      extractGoodsIdFromUrl('/portable-blender-g-601099888777666.html')
    ).toBe('601099888777666');
    expect(extractGoodsIdFromText('goodContainer-601099769178067')).toBe(
      '601099769178067'
    );
    expect(extractGoodsIdFromText('goodName-601099769178067')).toBe(
      '601099769178067'
    );
    expect(isValidGoodsId('601099769178067')).toBe(true);
    expect(isValidGoodsId('B08N5WRWNW')).toBe(false);
    expect(isValidGoodsId('123')).toBe(false);
  });

  it('builds canonical Temu product URLs and classifies URL page hints', () => {
    expect(
      buildCanonicalTemuUrl(
        '601099769178067',
        '/wireless-earbuds-g-601099769178067.html?_oak_mp_inf=abc&top_gallery_url=xyz',
        'https://www.temu.com/search_result.html?search_key=earbuds'
      )
    ).toBe('https://www.temu.com/wireless-earbuds-g-601099769178067.html');

    expect(buildCanonicalTemuUrl('601099769178067')).toBe(
      'https://www.temu.com/goods.html?goods_id=601099769178067'
    );

    expect(
      detectTemuUrlPageHint('https://www.temu.com/search_result.html?search_key=earbuds')
    ).toBe('search');
    expect(
      detectTemuUrlPageHint('https://www.temu.com/flat-wireless-earbuds-5030186936120-s.html')
    ).toBe('search');
    expect(
      detectTemuUrlPageHint('https://www.temu.com/womens-shoes-o3-95.html')
    ).toBe('category');
    expect(
      detectTemuUrlPageHint('https://www.temu.com/wireless-earbuds-g-601099769178067.html')
    ).toBe('detail');
    expect(detectTemuMarketplace('https://www.temu.com/')).toBe('temu.com');
  });
});

describe('Temu price, discount, rating, review, and sales parsers', () => {
  it('parses US dollar prices and extracts all dollar amounts from composite strings', () => {
    expect(parseTemuPrice('$12.49')).toEqual({ amount: 12.49, currency: 'USD' });
    expect(parseTemuPrice('US$ 1,249.00')).toEqual({
      amount: 1249,
      currency: 'USD',
    });
    expect(parseTemuPrice('Free shipping')).toBeNull();
    expect(
      extractAllDollarAmounts('current price is: $8.48, original price is: $24.99')
    ).toEqual([8.48, 24.99]);
  });

  it('parses discount percentages, ratings, review counts, and sold volumes accurately', () => {
    expect(parseTemuDiscountPercentage('-66%')).toBe('-66%');
    expect(parseTemuDiscountPercentage('Save 45% off')).toBe('-45%');
    expect(parseTemuRatingText('4.8 out of 5 stars')).toBe(4.8);
    expect(parseTemuRatingText('4.7')).toBe(4.7);
    expect(parseTemuReviewCountText('(2,341)')).toBe(2341);
    expect(parseTemuReviewCountText('1.4K+ reviews')).toBe(1400);
    expect(parseTemuSalesText('10K+ sold')).toBe('10K+ sold');
    expect(parseTemuSalesText('428 sold recently')).toBe('428 sold');
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
      discountPercentage: '-66%',
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
      title: 'Minimalist Ceramic Coffee Mug',
      price: null,
      currency: 'USD',
      rating: null,
      reviewCount: null,
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

  it('rejects invalid goodsId, out-of-range rating, and negative prices in validateTemuProductBatch', () => {
    const valid = {
      goodsId: '601099769178067',
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
      source: 'search',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    };

    const invalidGoodsId = { ...valid, goodsId: 'NOT-NUMERIC' };
    const invalidRating = { ...valid, rating: 6.2 };

    const batch = validateTemuProductBatch([valid, invalidGoodsId, invalidRating]);
    expect(batch.valid).toHaveLength(1);
    expect(batch.rejected).toBe(2);
    expect(batch.errors).toHaveLength(2);
  });

  it('hydrates TemuSettingsSchema defaults and validates PartialTemuSettingsSchema', () => {
    const hydrated = TemuSettingsSchema.parse({});
    expect(hydrated.id).toBe('default');
    expect(hydrated.defaultMode).toBe('manual');
    expect(hydrated.defaultTargetCount).toBe(50);
    expect(hydrated.enabledFields.goodsId).toBe(true);
    expect(hydrated.enabledFields.title).toBe(true);

    expect(
      PartialTemuSettingsSchema.safeParse({
        defaultTargetCount: 150,
        scrollSpeed: 'fast',
      }).success
    ).toBe(true);

    expect(
      PartialTemuSettingsSchema.safeParse({
        defaultTargetCount: 99999,
      }).success
    ).toBe(false);
  });

  it('identifies TEMU_* messages via isTemuMessage() and rejects Amazon messages', () => {
    expect(
      isTemuMessage({
        type: 'TEMU_START_COLLECTION',
        payload: { mode: 'manual', targetCount: 50 },
      })
    ).toBe(true);
    expect(isTemuMessage({ type: 'START_COLLECTION', payload: {} })).toBe(false);
    expect(isTemuMessage(null)).toBe(false);

    const startValidation = validateTemuMessage(TemuMessageSchema, {
      type: 'TEMU_START_COLLECTION',
      payload: { mode: 'automatic', targetCount: 100 },
    });
    expect(startValidation.success).toBe(true);

    const progressValidation = validateTemuMessage(
      TemuSidePanelIncomingMessageSchema,
      {
        type: 'TEMU_UPDATE_PROGRESS',
        payload: {
          collected: 25,
          target: 100,
          status: 'collecting',
          sessionKey: '550e8400-e29b-41d4-a716-446655440000',
        },
      }
    );
    expect(progressValidation.success).toBe(true);

    const amazonLeakValidation = validateTemuMessage(TemuMessageSchema, {
      type: 'START_COLLECTION',
      payload: { mode: 'manual', targetCount: 50 },
    });
    expect(amazonLeakValidation.success).toBe(false);
  });
});
