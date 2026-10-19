/**
 * SAD-274 (P0.1) - the three message registries must agree.
 *
 * A message type exists in three places:
 *   1. the `AmazonExtensionMessage` union (types/index.ts),
 *   2. the Zod discriminated union (schemas/messages.ts),
 *   3. the runtime allow-list `AMAZON_MESSAGE_TYPES` (schemas/validate-message.ts).
 *
 * Adding a type to only one of them used to fail silently: the router answered
 * "unknown", the message was dropped, and every test still passed. The
 * compile-time guards below fail `tsc` and the runtime assertions fail `vitest`
 * the moment the three lists drift apart.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import type { AmazonExtensionMessage } from '@/engines/amazon/types';
import { AmazonExtensionMessageSchema } from '@/engines/amazon/schemas/messages';
import {
  AMAZON_MESSAGE_TYPES,
  validateExtensionMessage,
} from '@/engines/amazon/schemas/validate-message';

type Expect<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

type SchemaType = z.infer<typeof AmazonExtensionMessageSchema>['type'];
type UnionType = AmazonExtensionMessage['type'];

/* Compile-time: the union and the Zod union must cover each other exactly. */
export type UnionIsCoveredBySchema = Expect<Extends<UnionType, SchemaType>>;
export type SchemaIsCoveredByUnion = Expect<Extends<SchemaType, UnionType>>;

/** Zod v4 exposes the members of a discriminated union as `options`. */
function schemaMessageTypes(): string[] {
  return AmazonExtensionMessageSchema.options.map(
    (option) => (option.shape as { type: { value: string } }).type.value
  );
}

const NEW_TYPES = [
  'SAVE_PRODUCT',
  'SAVE_CONTEXT_PRODUCT',
  'SAVE_JOB_UPDATE',
  'RETRY_SAVE_PRODUCT',
  'ASSIGN_SAVED_PRODUCT',
  'EXPORT_SAVED_PRODUCT',
] as const;

const PRODUCT = {
  asin: 'B08N5WRWNW',
  url: 'https://www.amazon.de/dp/B08N5WRWNW',
  title: 'Anker USB-C 65W Fast Wall Charger',
  price: 39.99,
  currency: 'EUR',
  source: 'search' as const,
};

const VALID: Record<(typeof NEW_TYPES)[number], unknown> = {
  SAVE_PRODUCT: {
    type: 'SAVE_PRODUCT',
    payload: {
      jobId: 'job-1',
      product: PRODUCT,
      context: {
        pageType: 'search',
        pageUrl: 'https://www.amazon.de/s?k=charger',
        triggeredBy: 'card-button',
      },
    },
  },
  SAVE_CONTEXT_PRODUCT: {
    type: 'SAVE_CONTEXT_PRODUCT',
    payload: { requestedAt: '2026-10-19T00:00:00.000Z' },
  },
  SAVE_JOB_UPDATE: {
    type: 'SAVE_JOB_UPDATE',
    payload: {
      jobId: 'job-1',
      asin: 'B08N5WRWNW',
      state: 'completed',
      enrichmentStatus: 'partial',
      collectionKey: 'oc_1760000000000',
      collectionLabel: 'Anker USB-C 65W Fast Wall Charger',
      updatedAt: '2026-10-19T00:00:01.000Z',
    },
  },
  RETRY_SAVE_PRODUCT: { type: 'RETRY_SAVE_PRODUCT', payload: { jobId: 'job-1' } },
  ASSIGN_SAVED_PRODUCT: {
    type: 'ASSIGN_SAVED_PRODUCT',
    payload: { jobId: 'job-1', choice: 'new' },
  },
  EXPORT_SAVED_PRODUCT: {
    type: 'EXPORT_SAVED_PRODUCT',
    payload: { collectionKey: 'oc_1760000000000' },
  },
};

describe('message registry sync', () => {
  it('AMAZON_MESSAGE_TYPES and the Zod union contain exactly the same types', () => {
    expect(new Set(AMAZON_MESSAGE_TYPES)).toEqual(new Set(schemaMessageTypes()));
  });

  it('every registry entry is listed exactly once', () => {
    const schemaTypes = schemaMessageTypes();
    expect(schemaTypes).toHaveLength(new Set(schemaTypes).size);
    expect(AMAZON_MESSAGE_TYPES.size).toBe(schemaTypes.length);
  });

  it.each(NEW_TYPES)('%s is registered and accepts its canonical payload', (type) => {
    expect(AMAZON_MESSAGE_TYPES.has(type)).toBe(true);
    const outcome = validateExtensionMessage(VALID[type]);
    expect(outcome.status).toBe('valid');
  });

  /** EXPORT_SAVED_PRODUCT is the one type whose payload is fully optional. */
  const MALFORMED: Record<(typeof NEW_TYPES)[number], unknown> = {
    SAVE_PRODUCT: {},
    SAVE_CONTEXT_PRODUCT: {},
    SAVE_JOB_UPDATE: {},
    RETRY_SAVE_PRODUCT: {},
    ASSIGN_SAVED_PRODUCT: {},
    EXPORT_SAVED_PRODUCT: { collectionKey: 42 },
  };

  it.each(NEW_TYPES)('%s rejects a malformed payload as invalid, not unknown', (type) => {
    const outcome = validateExtensionMessage({ type, payload: MALFORMED[type] });
    expect(outcome.status).toBe('invalid');
  });

  it('EXPORT_SAVED_PRODUCT accepts an empty payload (export the current collection)', () => {
    expect(validateExtensionMessage({ type: 'EXPORT_SAVED_PRODUCT', payload: {} }).status).toBe(
      'valid'
    );
  });

  it('a fabricated message type is unknown, never invalid', () => {
    expect(validateExtensionMessage({ type: 'ONE_CLICK_NOPE', payload: {} })).toEqual({
      status: 'unknown',
    });
  });

  it('SAVE_PRODUCT carries one product, never a batch', () => {
    const outcome = validateExtensionMessage({
      type: 'SAVE_PRODUCT',
      payload: {
        jobId: 'job-1',
        products: [PRODUCT],
        context: {
          pageType: 'search',
          pageUrl: 'https://www.amazon.de/s?k=charger',
          triggeredBy: 'context-menu',
        },
      },
    });
    expect(outcome.status).toBe('invalid');
  });

  it('SAVE_PRODUCT rejects a product without a valid ASIN or URL', () => {
    const outcome = validateExtensionMessage({
      type: 'SAVE_PRODUCT',
      payload: {
        jobId: 'job-1',
        product: { ...PRODUCT, asin: 'lowercase1', url: 'not-a-url' },
        context: {
          pageType: 'search',
          pageUrl: 'https://www.amazon.de/s?k=charger',
          triggeredBy: 'context-menu',
        },
      },
    });
    expect(outcome.status).toBe('invalid');
  });

  it('ASSIGN_SAVED_PRODUCT only accepts current | new', () => {
    expect(
      validateExtensionMessage({
        type: 'ASSIGN_SAVED_PRODUCT',
        payload: { jobId: 'job-1', choice: 'discard' },
      }).status
    ).toBe('invalid');
  });

  it('the pre-existing protocol is untouched', () => {
    for (const type of [
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
    ]) {
      expect(AMAZON_MESSAGE_TYPES.has(type as never)).toBe(true);
    }
  });
});
