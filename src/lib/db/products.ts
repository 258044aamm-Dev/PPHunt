import { db } from './database';
import type { Product } from '@/types/product';

export async function deleteProducts(ids: number[]): Promise<void> {
  await db.products.bulkDelete(ids);
}

export async function getExistingASINs(sessionKey: string): Promise<Set<string>> {
  const products = await db.products
    .where('sessionKey')
    .equals(sessionKey)
    .toArray();
  return new Set(products.map((p) => p.asin));
}
