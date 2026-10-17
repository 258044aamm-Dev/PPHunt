import { temuDb } from './database';
import type { TemuProduct } from '../types';

/**
 * Bulk upserts validated Temu products into `PPHuntTemuDB`, deduplicating by `[sessionId+goodsId]`,
 * enriching existing records with newly discovered non-null fields, and strictly enforcing
 * the `targetCount` cap per session.
 */
export async function upsertTemuProducts(
  incoming: Omit<TemuProduct, 'id'>[],
  targetCount?: number
): Promise<{
  inserted: number;
  updated: number;
  totalForSession: number;
}> {
  if (incoming.length === 0) {
    return { inserted: 0, updated: 0, totalForSession: 0 };
  }

  const sessionId = incoming[0]!.sessionId;

  return temuDb.transaction('rw', temuDb.products, async () => {
    const existingSessionProducts = await temuDb.products
      .where('sessionId')
      .equals(sessionId)
      .toArray();

    const existingByGoodsId = new Map<string, TemuProduct>();
    for (const p of existingSessionProducts) {
      existingByGoodsId.set(p.goodsId, p);
    }

    const toInsert: Omit<TemuProduct, 'id'>[] = [];
    const toUpdate: TemuProduct[] = [];

    for (const item of incoming) {
      const key = item.goodsId;
      const prev = existingByGoodsId.get(key);

      if (!prev) {
        if (
          typeof targetCount === 'number' &&
          targetCount > 0 &&
          existingByGoodsId.size >= targetCount
        ) {
          continue;
        }
        existingByGoodsId.set(key, item as TemuProduct);
        toInsert.push(item);
      } else if (prev.id != null) {
        let changed = false;
        const merged: TemuProduct = { ...prev };
        const nullableFields: (keyof TemuProduct)[] = [
          'title',
          'price',
          'listPrice',
          'discountPercentage',
          'dealBadge',
          'currency',
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
        ];
        for (const field of nullableFields) {
          if (merged[field] == null && item[field] != null) {
            (merged as Record<string, unknown>)[field] = item[field];
            changed = true;
          }
        }
        if (!merged.isPrime && item.isPrime) {
          merged.isPrime = true;
          changed = true;
        }
        if (!merged.isSponsored && item.isSponsored) {
          merged.isSponsored = true;
          changed = true;
        }
        if (
          (!merged.features || merged.features.length === 0) &&
          item.features &&
          item.features.length > 0
        ) {
          merged.features = item.features;
          changed = true;
        }
        if (changed) {
          existingByGoodsId.set(key, merged);
          toUpdate.push(merged);
        }
      }
    }

    if (toInsert.length > 0) {
      try {
        await temuDb.products.bulkAdd(toInsert as TemuProduct[]);
      } catch {
        for (const item of toInsert) {
          await temuDb.products.add(item as TemuProduct).catch(() => {});
        }
      }
    }

    if (toUpdate.length > 0) {
      try {
        await temuDb.products.bulkPut(toUpdate);
      } catch {
        for (const item of toUpdate) {
          await temuDb.products.put(item).catch(() => {});
        }
      }
    }

    return {
      inserted: toInsert.length,
      updated: toUpdate.length,
      totalForSession: existingByGoodsId.size,
    };
  });
}

export async function getTemuProductsBySession(
  sessionId: string
): Promise<TemuProduct[]> {
  return temuDb.products.where('sessionId').equals(sessionId).toArray();
}

export async function getExistingTemuGoodsIds(
  sessionId: string
): Promise<Set<string>> {
  const rows = await temuDb.products
    .where('sessionId')
    .equals(sessionId)
    .toArray();
  return new Set(rows.map((p) => p.goodsId));
}

export async function deleteTemuProducts(ids: number[]): Promise<void> {
  await temuDb.products.bulkDelete(ids);
}

export async function deleteTemuProductsBySession(
  sessionId: string
): Promise<number> {
  return temuDb.products.where('sessionId').equals(sessionId).delete();
}

export async function clearAllTemuProducts(): Promise<void> {
  await temuDb.products.clear();
}
