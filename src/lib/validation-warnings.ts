/**
 * Step 5.4 (SAD-180) — M-7: when a batch's schema-rejection ratio crosses
 * REJECTION_WARN_THRESHOLD, the side panel raises a non-fatal attention
 * toast. Extracted from App.tsx so the decision (threshold AND the
 * notifications gate) is unit-testable.
 */
export const REJECTION_WARN_THRESHOLD = 0.1;

/**
 * True when the operator should be warned: both counts are numbers, the
 * batch is non-empty, more than 10% of it was rejected, and the user has
 * notifications enabled (Phase 3 scope: in-panel toasts only, SAD-167).
 */
export function shouldWarnAboutRejections(
  rejected: unknown,
  rejectedOf: unknown,
  notificationsEnabled: boolean
): boolean {
  if (typeof rejected !== 'number' || typeof rejectedOf !== 'number') {
    return false;
  }
  if (!Number.isFinite(rejected) || !Number.isFinite(rejectedOf)) return false;
  if (rejectedOf <= 0 || rejected <= 0) return false;
  return (
    rejected / rejectedOf > REJECTION_WARN_THRESHOLD && notificationsEnabled
  );
}
