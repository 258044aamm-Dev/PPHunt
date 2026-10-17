// Anti-drift contract:
// START_COLLECTION targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX)
// RELOAD_AND_RETRY_COLLECTION targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX)
// COLLECT_PRODUCTS targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX)
export {
  CollectionStatusSchema,
  ExtensionMessageSchema,
  ProductsCollectedMessageSchema,
  StartCollectionMessageSchema,
} from '@/engines/amazon/schemas/messages';
