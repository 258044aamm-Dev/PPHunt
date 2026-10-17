import {
  TemuBackgroundIncomingMessageSchema,
  TemuContentIncomingMessageSchema,
  TemuSidepanelIncomingMessageSchema,
  type TemuBackgroundIncomingMessage,
  type TemuContentIncomingMessage,
  type TemuSidepanelIncomingMessage,
} from './messages';

/**
 * Type guard checking whether an incoming raw runtime message is addressed
 * to the Temu engine (all Temu message types carry the `TEMU_` prefix).
 */
export function isTemuMessage(raw: unknown): raw is { type: `TEMU_${string}` } {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'type' in raw &&
    typeof (raw as { type?: unknown }).type === 'string' &&
    (raw as { type: string }).type.startsWith('TEMU_')
  );
}

export function validateTemuBackgroundIncomingMessage(
  raw: unknown
): TemuBackgroundIncomingMessage | null {
  const result = TemuBackgroundIncomingMessageSchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      '[PPHunt:Temu] Background dropped invalid message:',
      result.error.issues
    );
    return null;
  }
  return result.data;
}

export function validateTemuContentIncomingMessage(
  raw: unknown
): TemuContentIncomingMessage | null {
  const result = TemuContentIncomingMessageSchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      '[PPHunt:Temu] Content dropped invalid message:',
      result.error.issues
    );
    return null;
  }
  return result.data;
}

export function validateTemuSidepanelIncomingMessage(
  raw: unknown
): TemuSidepanelIncomingMessage | null {
  const result = TemuSidepanelIncomingMessageSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  return result.data;
}
