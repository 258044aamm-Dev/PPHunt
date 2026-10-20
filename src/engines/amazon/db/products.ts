import { MAX_SEEDED_ASINS } from '../constants/defaults';
import { ScrapedProductSchema } from '../schemas/scraped-product';
import type { Product, ScrapedProduct } from '../types';
import { db } from './database';

function enrichStoredProductFields(
  existing: Product,
  incoming: ScrapedProduct,
): Partial<Product> | null {
  const patch: Partial<Product> = {};
  let hasChanges = false;

  const nullableKeys = [
    'price',
    'listPrice',
    'discountPercentage',
    'dealBadge',
    'rating',
    'reviewCount',
    'bestSellersRank',
    'pastMonthSales',
    'coupon',
    'badge',
    'delivery',
    'imageUrl',
    'brand',
    'availability',
    'seller',
    'description',
    // SAD-349: lets a later pass over the same ASIN backfill a warranty the
    // first pass did not see (e.g. a listing row later re-collected on the PDP).
    'warrantyDescription',
    'warrantyDescriptionRaw',
  ] as const;

  for (const key of nullableKeys) {
    const currentVal = existing[key];
    const nextVal = incoming[key];
    if (
      (currentVal === null || currentVal === undefined) &&
      nextVal !== null &&
      nextVal !== undefined
    ) {
      (patch as Record<string, unknown>)[key] = nextVal;
      hasChanges = true;
    }
  }

  if (!existing.isPrime && incoming.isPrime) {
    patch.isPrime = true;
    hasChanges = true;
  }

  if (
    (!existing.features || existing.features.length === 0) &&
    incoming.features &&
    incoming.features.length > 0
  ) {
    patch.features = incoming.features;
    hasChanges = true;
  }

  return hasChanges ? patch : null;
}

/**
 * Validates and persists a batch of scraped Amazon products for `sessionKey`.
 * Deduplicates by `(sessionKey, asin)`, enriches late-hydrated fields on existing rows,
 * and falls back to per-item `db.products.add` if `bulkAdd` fails.
 */
export async function addProducts(
  products: readonly ScrapedProduct[],
  sessionKey: string,
): Promise<number> {
  if (!products || products.length === 0) return 0;

  const validIncoming: ScrapedProduct[] = [];
  const seenInBatch = new Set<string>();

  for (const raw of products) {
    const parsed = ScrapedProductSchema.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    if (seenInBatch.has(item.asin)) continue;
    seenInBatch.add(item.asin);
    validIncoming.push(item);
  }

  if (validIncoming.length === 0) return 0;

  const existingRows = await db.products
    .where('sessionKey')
    .equals(sessionKey)
    .toArray();
  const existingByAsin = new Map<string, Product>();
  for (const row of existingRows) {
    existingByAsin.set(row.asin, row);
  }

  const now = new Date().toISOString();
  const toInsert: Product[] = [];

  for (const item of validIncoming) {
    const existing = existingByAsin.get(item.asin);
    if (existing) {
      const patch = enrichStoredProductFields(existing, item);
      if (patch && existing.id !== undefined) {
        try {
          await db.products.update(existing.id, patch);
        } catch {
          // Ignore enrichment failure
        }
      }
      continue;
    }

    toInsert.push({
      ...item,
      collectedAt: now,
      sessionKey,
    });
  }

  if (toInsert.length === 0) {
    return 0;
  }

  try {
    await db.products.bulkAdd(toInsert);
    return toInsert.length;
  } catch {
    let added = 0;
    for (const row of toInsert) {
      try {
        await db.products.add(row);
        added += 1;
      } catch {
        // Skip individual failed item
      }
    }
    return added;
  }
}

export async function getProductsBySession(
  sessionKey: string,
): Promise<Product[]> {
  return db.products.where('sessionKey').equals(sessionKey).toArray();
}

export async function getProductCountBySession(
  sessionKey: string,
): Promise<number> {
  return db.products.where('sessionKey').equals(sessionKey).count();
}

/**
 * Returns up to `limit` (`MAX_SEEDED_ASINS = 10_000`) unique ASINs already stored for `sessionKey`.
 */
export async function getExistingASINs(
  sessionKey: string,
  limit: number = MAX_SEEDED_ASINS,
): Promise<string[]> {
  if (!sessionKey) return [];
  const rows = await db.products
    .where('sessionKey')
    .equals(sessionKey)
    .limit(Math.max(1, limit))
    .toArray();

  const seen = new Set<string>();
  const asins: string[] = [];
  for (const row of rows) {
    if (row.asin && !seen.has(row.asin)) {
      seen.add(row.asin);
      asins.push(row.asin);
      if (asins.length >= limit) break;
    }
  }
  return asins;
}

export async function deleteProductsBySession(
  sessionKey: string,
): Promise<number> {
  return db.products.where('sessionKey').equals(sessionKey).delete();
}

export const clearSessionProducts = deleteProductsBySession;

export async function deleteProduct(id: number): Promise<void> {
  await db.products.delete(id);
}

export async function deleteProducts(ids: number[]): Promise<void> {
  if (!ids || ids.length === 0) return;
  await db.products.bulkDelete(ids);
}
