import { AMAZON_MARKETPLACE_DOMAINS } from '../utils/amazon-url';

/**
 * SAD-278 (plan 3.9 / D9): one list feeds three consumers that must agree —
 * the content-script `matches`, the context menu's `documentUrlPatterns`, and
 * `host_permissions`.
 *
 * They drifted before this module existed: the content script listed 22
 * marketplaces, `host_permissions` only 10, and `amazon.co.za` was in neither
 * even though `isAmazonUrl()` recognises it. The visible symptom was a
 * marketplace where the button worked but `scripting.executeScript()` could not
 * re-inject the content script after service-worker suspension.
 */

/** `amazon.de` -> `*://*.amazon.de/*` */
export function buildAmazonMatchPattern(domain: string): string {
  return `*://*.${domain}/*`;
}

/** Every supported marketplace, in manifest order. */
export const AMAZON_MATCH_PATTERNS: readonly string[] =
  AMAZON_MARKETPLACE_DOMAINS.map(buildAmazonMatchPattern);

/**
 * Exactly the same surface as the content script. A host permission is what
 * makes `fetch`, `scripting.executeScript` and menu visibility work without an
 * additional user gesture.
 */
export const AMAZON_HOST_PERMISSIONS: readonly string[] = AMAZON_MATCH_PATTERNS;
