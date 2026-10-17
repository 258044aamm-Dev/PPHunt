import { z } from 'zod';
import { AmazonProductSchema } from './product';

export const AmazonScrapedProductSchema = AmazonProductSchema.omit({
  id: true,
  collectedAt: true,
  sessionId: true,
});

export const ScrapedProductSchema = AmazonScrapedProductSchema;

export type ValidatedScrapedAmazonProduct = z.infer<typeof AmazonScrapedProductSchema>;
