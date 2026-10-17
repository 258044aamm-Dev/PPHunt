/**
 * Runtime message validation for both routers (Step 2.4, SAD-164 — H-3 + C-2).
 *
 * spec/11-messaging-protocol.md:161-170 requires every message to be
 * Zod-validated and invalid messages to be discarded *without throwing*.
 * Both routers call this before touching `payload`.
 *
 * Three outcomes:
 * - `valid`   — passes ExtensionMessageSchema; the ORIGINAL object is handed
 *               back typed as `Message` (see note below).
 * - `invalid` — the `type` is one of the schema's 14, but the message does not
 *               conform. Routers answer `{ ok: false, error: 'INVALID_MESSAGE' }`.
 * - `unknown` — no string `type`, or a type outside the schema. Routers stay
 *               silent and return false, exactly like the pre-existing
 *               `default: return false` behaviour in background.ts.
 */
import { ExtensionMessageSchema } from './messages';
import type { z } from 'zod';

export type Message = z.infer<typeof ExtensionMessageSchema>;

// Known discriminators, derived from the schema itself so the routers and the
// schema can never drift apart again.
const KNOWN_TYPES: ReadonlySet<string> = new Set(
  (
    ExtensionMessageSchema as unknown as {
      options: ReadonlyArray<{ shape: { type: { value: string } } }>;
    }
  ).options.map((option) => option.shape.type.value)
);

export type MessageValidation =
  | { status: 'valid'; message: Message }
  | { status: 'invalid'; type: string; issues: string }
  | { status: 'unknown' };

export function validateExtensionMessage(raw: unknown): MessageValidation {
  const parsed = ExtensionMessageSchema.safeParse(raw);
  if (parsed.success) {
    // Deliberately return the ORIGINAL object (typed) rather than `parsed.data`:
    // Zod objects strip unknown keys, and later phases send payload fields
    // before the schema grows them (Phase 3 scroll fields, Phase 4
    // `existingAsins`). The parse is the gate; the payload stays intact.
    return { status: 'valid', message: raw as Message };
  }

  const type = (raw as { type?: unknown } | null | undefined)?.type;
  if (typeof type === 'string' && KNOWN_TYPES.has(type)) {
    return {
      status: 'invalid',
      type,
      issues: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  return { status: 'unknown' };
}
