import { z } from 'zod';
// L-1 (SAD-162): single source of truth for the target-count bounds, shared
// with messages.ts and the UI components.
import { TARGET_MIN, TARGET_MAX } from '@/constants/defaults';
import {
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_EXPORT_IMAGES,
  DEFAULT_INCLUDE_BOM,
} from '@/constants/defaults';

export const DEFAULT_ENABLED_FIELDS = {
  title: true,
  asin: true,
  url: true,
  price: true,
  listPrice: true,
  discountPercentage: true,
  dealBadge: true,
  currency: true,
  rating: true,
  reviewCount: true,
  bestSellersRank: true,
  pastMonthSales: true,
  coupon: true,
  badge: true,
  delivery: true,
  imageUrl: true,
  isSponsored: true,
  isPrime: true,
  brand: true,
  availability: true,
  seller: true,
  description: false,
  features: false,
} as const;

export const SettingsSchema = z.object({
  id: z.literal('default').default('default'),
  version: z.number().int().default(1),

  // General
  defaultMode: z.enum(['manual', 'automatic']).default('manual'),
  defaultTargetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX).default(50),

  // Automatic scrolling
  scrollSpeed: z.number().int().min(100).max(3000).default(800),
  scrollInterval: z.number().int().min(200).max(5000).default(500),
  waitAfterScroll: z.number().int().min(500).max(10000).default(1500),

  // Field toggles (all core + pricing/deal/BSR/market intelligence fields enabled by default; description & features excluded by default)
  enabledFields: z
    .object({
      title: z.boolean().default(true),
      asin: z.boolean().default(true),
      url: z.boolean().default(true),
      price: z.boolean().default(true),
      listPrice: z.boolean().default(true),
      discountPercentage: z.boolean().default(true),
      dealBadge: z.boolean().default(true),
      currency: z.boolean().default(true),
      rating: z.boolean().default(true),
      reviewCount: z.boolean().default(true),
      bestSellersRank: z.boolean().default(true),
      pastMonthSales: z.boolean().default(true),
      coupon: z.boolean().default(true),
      badge: z.boolean().default(true),
      delivery: z.boolean().default(true),
      imageUrl: z.boolean().default(true),
      isSponsored: z.boolean().default(true),
      isPrime: z.boolean().default(true),
      brand: z.boolean().default(true),
      availability: z.boolean().default(true),
      seller: z.boolean().default(true),
      description: z.boolean().default(false),
      features: z.boolean().default(false),
    })
    .default({ ...DEFAULT_ENABLED_FIELDS }),

  // Behavior
  duplicateDetection: z.boolean().default(true),
  notifications: z.boolean().default(true),

  // Export defaults
  // H-1 (SAD-167): harmonised with ExportFormat ('excel', not 'xlsx'). The
  // union + transform upgrades legacy persisted 'xlsx' rows transparently on
  // read, so existing users never hit a parse failure (which pre-SAD-169
  // white-screened the panel).
  exportFormat: z
    .union([
      z.literal('csv'),
      z.literal('excel'),
      z.literal('clipboard'),
      z.literal('xlsx'), // legacy value, transformed below
    ])
    .transform((v): 'csv' | 'excel' | 'clipboard' =>
      v === 'xlsx' ? 'excel' : v
    )
    .default(DEFAULT_EXPORT_FORMAT),
  // Empty means "use the dated template" (pphunt-export-<date>) — that keeps
  // a fresh install byte-identical to the pre-wiring behaviour (Step 3.0).
  exportFilename: z.string().default(''),
  includeBOM: z.boolean().default(DEFAULT_INCLUDE_BOM),
  // M-6 (SAD-192) decision D4: image embedding policy for XLSX exports.
  // Rows persisted before this field existed parse to the 'auto' default.
  exportImages: z
    .enum(['auto', 'always', 'never'])
    .default(DEFAULT_EXPORT_IMAGES),
});

export type ValidatedSettings = z.infer<typeof SettingsSchema>;
