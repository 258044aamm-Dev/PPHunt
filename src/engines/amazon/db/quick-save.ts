import Dexie from 'dexie';
import { ScrapedProductSchema } from '../schemas/scraped-product';
import { mergeScrapedProductFields } from '../scraper/dedup';
import type {
  Product,
  ProductSnapshot,
  ScrapedAmazonProduct,
  ScrapedProduct,
} from '../types';
import { db } from './database';

/**
 * SAD-277: write path for one-click saves.
 *
 * `addProducts()` is deliberately fill-only (a full-page run must never mutate a
 * row it already wrote), so a *fresh, user-initiated* save needs its own upsert:
 * volatile price/availability fields are refreshed, everything else is fill-only
 * and null never overwrites a known value.
 */

/** Fields that describe the *current* state of a product and may be refreshed. */
export const QUICK_SAVE_VOLATILE_FIELDS = [
  'price',
  'listPrice',
  'discountPercentage',
  'dealBadge',
  'coupon',
  'delivery',
  'availability',
  'rating',
  'reviewCount',
  'bestSellersRank',
  'pastMonthSales',
  'badge',
] as const;

export type QuickSaveValidationErrorCode =
  | 'INVALID_PRODUCT'
  | 'MISSING_ASIN'
  | 'MISSING_SESSION_KEY';

export class QuickSaveValidationError extends Error {
  readonly code: QuickSaveValidationErrorCode;

  constructor(code: QuickSaveValidationErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'QuickSaveValidationError';
    this.code = code;
  }
}

export interface QuickSaveUpsertResult {
  productId: number;
  /** True when the row did not exist before this call. */
  created: boolean;
  /** Stored columns this call changed (empty when the save was a no-op). */
  updatedFields: string[];
  /**
   * The stored row and the incoming product disagree on currency. The price was
   * deliberately NOT refreshed; the snapshot keeps the incoming currency.
   */
  currencyMismatch: boolean;
}

function asScraped(product: Product): ScrapedAmazonProduct {
  return product as unknown as ScrapedAmazonProduct;
}

function pickVolatile(
  product: ScrapedAmazonProduct,
  options: { skipPrice: boolean },
): ScrapedAmazonProduct {
  const refresh = {
    asin: product.asin,
    url: product.url,
    source: product.source,
  } as unknown as ScrapedAmazonProduct;

  for (const field of QUICK_SAVE_VOLATILE_FIELDS) {
    if (options.skipPrice && (field === 'price' || field === 'listPrice')) continue;
    const value = product[field];
    if (value !== null && value !== undefined) {
      (refresh as unknown as Record<string, unknown>)[field] = value;
    }
  }
  return refresh;
}

function diffProduct(existing: Product, next: Product): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === 'id') continue;
    const before = (existing as unknown as Record<string, unknown>)[key];
    const after = (next as unknown as Record<string, unknown>)[key];
    if (before !== after) changed.push(key);
  }
  return changed.sort();
}

/**
 * Creates or refreshes the single `(sessionKey, asin)` row for a one-click save.
 *
 * Merge policy (plan 6.4):
 * - volatile fields: incoming non-null wins, null never overwrites;
 * - identity fields (`title`, `imageUrl`, `brand`, `seller`), `features` and
 *   `description`: fill-only, delegated to the tested `mergeScrapedProductFields`;
 * - `isPrime`: OR; `isSponsored`: OR (SAD-391 D6 — never cleared by a later
 *   save); listings context (`placements`, `sectionLabel`): appended;
 * - price is frozen when the currencies differ (`currencyMismatch: true`).
 */
export async function upsertProductFromQuickSave(
  product: ScrapedProduct,
  sessionKey: string,
  options: { collectedAt?: string } = {},
): Promise<QuickSaveUpsertResult> {
  if (!sessionKey) {
    throw new QuickSaveValidationError('MISSING_SESSION_KEY');
  }

  const parsed = ScrapedProductSchema.safeParse(product);
  if (!parsed.success) {
    const hasAsin = typeof (product as { asin?: unknown })?.asin === 'string';
    throw new QuickSaveValidationError(
      hasAsin ? 'INVALID_PRODUCT' : 'MISSING_ASIN',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }

  const incoming = parsed.data;
  const collectedAt = options.collectedAt ?? new Date().toISOString();

  return db.transaction('rw', db.products, async () => {
    const existing = await db.products
      .where('[sessionKey+asin]')
      .equals([sessionKey, incoming.asin])
      .first();

    if (!existing) {
      const row: Product = {
        ...incoming,
        sessionKey,
        collectedAt,
      };
      const productId = (await db.products.add(row)) as number;
      return {
        productId,
        created: true,
        updatedFields: Object.keys(incoming).sort(),
        currencyMismatch: false,
      };
    }

    const currencyMismatch = Boolean(
      existing.currency &&
        incoming.currency &&
        existing.currency !== incoming.currency,
    );

    const merged: Product = { ...existing };
    // A cross-currency save must not relabel a stored price: `mergeScrapedProductFields`
    // follows `price` with `currency`, so the currency and the price travel together.
    const fillSource = currencyMismatch
      ? { ...incoming, price: null, listPrice: null, currency: null }
      : incoming;
    // Fill-only pass: empty identity/context fields, isPrime OR, placements.
    mergeScrapedProductFields(asScraped(merged), fillSource, {});
    // Volatile pass: refresh only current-state fields, never with null.
    mergeScrapedProductFields(
      asScraped(merged),
      pickVolatile(incoming, { skipPrice: currencyMismatch }),
      { preferSource: true },
    );
    // `mergeScrapedProductFields` has no array case for `features`.
    if (
      (!merged.features || merged.features.length === 0) &&
      incoming.features &&
      incoming.features.length > 0
    ) {
      merged.features = incoming.features;
    }
    // SAD-391 (D6): sponsorship is sticky across saves, like `isPrime`. The
    // fill-only pass above already appended the newer placement (so a later
    // organic save still shows as 'Organic Search' in `placements`), and the
    // volatile pass carries no listing fields, so it can no longer clear the
    // flag. What remains is the OR: an ad save of a product first saved from
    // an organic card.
    if (incoming.isSponsored === true && merged.isSponsored !== true) {
      merged.isSponsored = true;
      if (merged.listingCategory === 'organic') {
        merged.listingCategory = 'sponsored';
      }
    }
    merged.collectedAt = collectedAt;

    const updatedFields = diffProduct(existing, merged);
    const { id: existingId } = existing;
    if (updatedFields.length > 0 && existingId !== undefined) {
      const { id: _ignoredId, ...changes } = merged;
      await db.products.update(existingId, changes);
    }

    return {
      productId: existingId as number,
      created: false,
      updatedFields,
      currencyMismatch,
    };
  });
}

export interface AppendSnapshotResult {
  id: number | null;
  created: boolean;
}

/**
 * Records one observation. Replaying the same `jobId` + `source` for an ASIN is
 * idempotent, so a retried or re-delivered save cannot invent a price change.
 */
export async function appendSnapshot(
  snapshot: Omit<ProductSnapshot, 'id'>,
  options: { capturedAt?: string } = {},
): Promise<AppendSnapshotResult> {
  const row: ProductSnapshot = {
    ...snapshot,
    capturedAt:
      options.capturedAt ?? snapshot.capturedAt ?? new Date().toISOString(),
  };

  return db.transaction('rw', db.snapshots, async () => {
    const duplicate = await db.snapshots
      .where('[asin+capturedAt]')
      .between([row.asin, Dexie.minKey], [row.asin, Dexie.maxKey])
      .filter(
        (candidate) =>
          candidate.jobId === row.jobId && candidate.source === row.source,
      )
      .first();

    if (duplicate?.id !== undefined) {
      return { id: duplicate.id, created: false };
    }

    const id = (await db.snapshots.add(row)) as number;
    return { id, created: true };
  });
}

export type MoveProductReason = 'NOT_FOUND' | 'SAME_COLLECTION';

export interface MoveProductResult {
  moved: boolean;
  /** The destination already held this ASIN, so the two rows were merged. */
  merged: boolean;
  reason?: MoveProductReason;
  productId?: number;
}

/**
 * Moves one product (and its snapshots) between collections inside a single
 * transaction. Used by "Ask Every Time" -> "Create new collection".
 */
export async function moveProductToCollection(
  asin: string,
  fromSessionKey: string,
  toSessionKey: string,
): Promise<MoveProductResult> {
  if (!asin || !fromSessionKey || !toSessionKey) {
    throw new QuickSaveValidationError('MISSING_SESSION_KEY');
  }
  if (fromSessionKey === toSessionKey) {
    return { moved: false, merged: false, reason: 'SAME_COLLECTION' };
  }

  return db.transaction('rw', [db.products, db.snapshots], async () => {
    const source = await db.products
      .where('[sessionKey+asin]')
      .equals([fromSessionKey, asin])
      .first();

    if (!source || source.id === undefined) {
      return { moved: false, merged: false, reason: 'NOT_FOUND' as const };
    }

    const target = await db.products
      .where('[sessionKey+asin]')
      .equals([toSessionKey, asin])
      .first();

    let merged = false;
    let productId = source.id;

    if (target && target.id !== undefined) {
      // Merge into the destination row; null from the source never wins.
      const mergedRow: Product = { ...target };
      mergeScrapedProductFields(
        asScraped(mergedRow),
        asScraped(source),
        {},
      );
      mergedRow.collectedAt = target.collectedAt;
      const { id: targetId } = target;
      const { id: _ignoredId, ...targetChanges } = mergedRow;
      await db.products.update(targetId, targetChanges);
      await db.products.delete(source.id);
      productId = targetId;
      merged = true;
    } else {
      await db.products.update(source.id, { sessionKey: toSessionKey });
    }

    const snapshots = await db.snapshots
      .where('sessionKey')
      .equals(fromSessionKey)
      .filter((snapshot) => snapshot.asin === asin)
      .toArray();

    for (const snapshot of snapshots) {
      if (snapshot.id === undefined) continue;
      await db.snapshots.update(snapshot.id, { sessionKey: toSessionKey });
    }

    return { moved: true, merged, productId };
  });
}

export interface SnapshotContextOptions {
  sessionKey: string;
  jobId: string;
  source: 'listing' | 'detail';
  capturedAt?: string;
}

/**
 * Projects a scraped product onto the snapshot shape. Unavailable values become
 * `null` - never a placeholder - so a later reader can tell "unknown" from "zero".
 */
export function snapshotFromProduct(
  product: ScrapedProduct,
  options: SnapshotContextOptions,
): Omit<ProductSnapshot, 'id'> {
  return {
    asin: product.asin,
    sessionKey: options.sessionKey,
    jobId: options.jobId,
    source: options.source,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    price: product.price ?? null,
    listPrice: product.listPrice ?? null,
    discountPercentage: product.discountPercentage ?? null,
    currency: product.currency ?? null,
    rating: product.rating ?? null,
    reviewCount: product.reviewCount ?? null,
    bestSellersRank: product.bestSellersRank ?? null,
    availability: product.availability ?? null,
    coupon: product.coupon ?? null,
    dealBadge: product.dealBadge ?? null,
    delivery: product.delivery ?? null,
  };
}

export interface SaveQuickProductInput {
  product: ScrapedProduct;
  sessionKey: string;
  jobId: string;
  source?: 'listing' | 'detail';
  collectedAt?: string;
  context?: ProductSnapshot['context'];
}

export interface SaveQuickProductResult {
  upsert: QuickSaveUpsertResult;
  snapshot: AppendSnapshotResult;
}

/**
 * The single write performed by a one-click save: the product row and its
 * observation land in one transaction, so a retry can never leave one without
 * the other.
 */
export async function saveQuickProduct(
  input: SaveQuickProductInput,
): Promise<SaveQuickProductResult> {
  return db.transaction('rw', [db.products, db.snapshots], async () => {
    const upsert = await upsertProductFromQuickSave(
      input.product,
      input.sessionKey,
      { collectedAt: input.collectedAt },
    );

    const snapshot = await appendSnapshot({
      ...snapshotFromProduct(input.product, {
        sessionKey: input.sessionKey,
        jobId: input.jobId,
        source: input.source ?? 'listing',
        capturedAt: input.collectedAt,
      }),
      context: input.context,
    });

    return { upsert, snapshot };
  });
}
