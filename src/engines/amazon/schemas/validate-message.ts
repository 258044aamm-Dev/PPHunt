import type { z } from 'zod';
import type { AmazonExtensionMessage } from '../types';
import { AmazonExtensionMessageSchema } from './messages';

export const AMAZON_MESSAGE_TYPES = new Set<AmazonExtensionMessage['type']>([
  'START_COLLECTION',
  'RELOAD_AND_RETRY_COLLECTION',
  'PAUSE_COLLECTION',
  'RESUME_COLLECTION',
  'STOP_COLLECTION',
  'COLLECT_PRODUCTS',
  'PAUSE_SCROLLING',
  'RESUME_SCROLLING',
  'STOP_COLLECTION_CMD',
  'PRODUCTS_COLLECTED',
  'COLLECTION_PROGRESS',
  'CONTENT_ERROR',
  'UPDATE_PROGRESS',
  'TAB_STATUS_CHANGED',
]);

export type MessageValidationOutcome =
  | { status: 'valid'; message: AmazonExtensionMessage }
  | { status: 'invalid'; issues: z.core.$ZodIssue[] }
  | { status: 'unknown' };

export function isAmazonMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const candidateType = (raw as { type?: unknown }).type;
  if (typeof candidateType !== 'string') return false;
  return AMAZON_MESSAGE_TYPES.has(candidateType as AmazonExtensionMessage['type']);
}

/**
 * Validates an incoming extension message:
 * - `'unknown'` when `raw` is not an object or its `type` is not a recognized Amazon protocol message.
 * - `'invalid'` when `type` is recognized but the payload fails schema validation.
 * - `'valid'` when validation succeeds, returning the original `raw` reference so extra payload properties survive.
 */
export function validateExtensionMessage(raw: unknown): MessageValidationOutcome {
  if (!raw || typeof raw !== 'object') {
    return { status: 'unknown' };
  }
  const candidateType = (raw as { type?: unknown }).type;
  if (
    typeof candidateType !== 'string' ||
    !AMAZON_MESSAGE_TYPES.has(candidateType as AmazonExtensionMessage['type'])
  ) {
    return { status: 'unknown' };
  }

  const parsed = AmazonExtensionMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: 'invalid',
      issues: parsed.error.issues,
    };
  }

  return {
    status: 'valid',
    message: raw as AmazonExtensionMessage,
  };
}

export const validateAmazonMessage = validateExtensionMessage;
export const validateMessage = validateExtensionMessage;
