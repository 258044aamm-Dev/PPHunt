import type { AmazonExtensionMessage } from '../types';
import { AmazonExtensionMessageSchema } from './messages';

export const AMAZON_MESSAGE_TYPES = new Set<AmazonExtensionMessage['type']>([
  'COLLECT_PRODUCTS',
  'PAUSE_COLLECTION',
  'RESUME_COLLECTION',
  'STOP_COLLECTION',
  'COLLECT_SINGLE_PAGE',
  'PRODUCTS_COLLECTED',
  'COLLECTION_PROGRESS',
  'COLLECTION_COMPLETE',
  'COLLECTION_ERROR',
  'START_COLLECTION',
  'COLLECT_MANUAL',
  'EXPORT_DATA',
  'CLEAR_SESSION',
  'UPDATE_PROGRESS',
  'GET_PAGE_STATUS',
  'PAGE_STATUS',
  'GET_ACTIVE_SESSION',
  'RESUME_INTERRUPTED_SESSION',
  'DISCARD_INTERRUPTED_SESSION',
]);

export type AmazonMessageValidationResult =
  | { success: true; data: AmazonExtensionMessage }
  | { success: false; error: string };

/**
 * Checks whether an incoming runtime message has an Amazon message `type`
 * (and is not a `TEMU_*` message).
 */
export function isAmazonMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const candidateType = (raw as { type?: unknown }).type;
  if (typeof candidateType !== 'string') return false;
  return AMAZON_MESSAGE_TYPES.has(candidateType as AmazonExtensionMessage['type']);
}

/**
 * Validates an incoming runtime message against `AmazonExtensionMessageSchema`.
 */
export function validateAmazonMessage(raw: unknown): AmazonMessageValidationResult {
  if (!raw || typeof raw !== 'object') {
    return {
      success: false,
      error: 'Invalid message: expected a non-null object',
    };
  }

  const parsed = AmazonExtensionMessageSchema.safeParse(raw);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    return {
      success: false,
      error: `Invalid message payload: ${issueSummary}`,
    };
  }

  return {
    success: true,
    data: parsed.data as AmazonExtensionMessage,
  };
}

export const validateMessage = validateAmazonMessage;
