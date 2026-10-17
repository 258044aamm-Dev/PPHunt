// Anti-drift contract:
// defaultTargetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX)
export {
  DEFAULT_ENABLED_FIELDS,
  SettingsSchema,
  type ValidatedSettings,
} from '@/engines/amazon/schemas/settings';
