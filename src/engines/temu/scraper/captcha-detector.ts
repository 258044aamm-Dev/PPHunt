/**
 * Temu CAPTCHA, Security Verification & Access Restriction Detector.
 *
 * STRICT COMPLIANCE RULE:
 * Never attempt to solve, click through, or bypass any Temu verification challenge,
 * slider puzzle, QR verification, or login wall. When detected, collection must
 * pause/stop immediately and surface a clear diagnostic message to the user.
 */

export interface TemuRestrictionStatus {
  restricted: boolean;
  kind: 'captcha' | 'access_restricted' | null;
  reason: string | null;
}

const CAPTCHA_DOM_SELECTORS = [
  '#captcha',
  'input#captcha',
  '[class*="verificationDialog"]',
  '[id*="verification" i][role="dialog"]',
  'iframe[src*="verify" i]',
  'iframe[src*="captcha" i]',
] as const;

const CAPTCHA_TEXT_PATTERNS: RegExp[] = [
  /\bVerify\s+your\s+identity\b/i,
  /\bSecurity\s+Verification\b/i,
  /\bSlide\s+to\s+complete\s+the\s+puzzle\b/i,
  /\bDrag\s+the\s+slider\s+to\s+fit\s+the\s+puzzle\b/i,
  /\bSelect\s+all\s+images\s+with\b/i,
  /\bVerification\s+failed\.\s+Please\s+scan\s+the\s+QR\s+code\b/i,
];

const ACCESS_RESTRICTION_PATTERNS: RegExp[] = [
  /\bWe\s+are\s+currently\s+experiencing\s+a\s+high\s+volume\s+of\s+visitors\b/i,
  /\bAccess\s+Denied\b/i,
  /\b403\s+Forbidden\b/i,
  /\bToo\s+Many\s+Requests\b/i,
];

/**
 * Checks whether the current Temu document is displaying a CAPTCHA / security
 * verification challenge or an access/rate-limit restriction.
 */
export function detectTemuChallengeOrRestriction(
  document: Document
): TemuRestrictionStatus {
  try {
    // 1. Check explicit verification dialog / captcha DOM selectors
    for (const selector of CAPTCHA_DOM_SELECTORS) {
      const el = document.querySelector(selector);
      if (el && isElementVisible(el)) {
        return {
          restricted: true,
          kind: 'captcha',
          reason:
            'Temu is displaying a security verification / CAPTCHA challenge.',
        };
      }
    }

    // 2. Check active modal dialogs or page body when no product cards exist
    const dialogs = Array.from(
      document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
    );
    for (const dialog of dialogs) {
      if (!isElementVisible(dialog)) continue;
      const dialogText = (dialog.textContent ?? '').replace(/\s+/g, ' ').trim();
      for (const pattern of CAPTCHA_TEXT_PATTERNS) {
        if (pattern.test(dialogText)) {
          return {
            restricted: true,
            kind: 'captcha',
            reason:
              'Temu requested identity or security verification in a modal dialog.',
          };
        }
      }
    }

    // 3. If the page has zero product cards and zero PDP landmarks, inspect body text
    const hasProductContent =
      document.querySelector(
        '[data-tooltip^="goodContainer-"], a[href*="-g-"], a[href*="goods.html"], #goods_price'
      ) !== null;

    if (!hasProductContent) {
      const titleAndBody = `${document.title ?? ''} ${(
        document.body?.textContent ?? ''
      ).slice(0, 4000)}`
        .replace(/\s+/g, ' ')
        .trim();

      for (const pattern of CAPTCHA_TEXT_PATTERNS) {
        if (pattern.test(titleAndBody)) {
          return {
            restricted: true,
            kind: 'captcha',
            reason:
              'Temu is displaying a security verification / CAPTCHA page.',
          };
        }
      }

      for (const pattern of ACCESS_RESTRICTION_PATTERNS) {
        if (pattern.test(titleAndBody)) {
          return {
            restricted: true,
            kind: 'access_restricted',
            reason:
              'Temu temporarily restricted access due to high visitor volume or rate limiting.',
          };
        }
      }
    }
  } catch {
    // Never throw from restriction detector
  }

  return {
    restricted: false,
    kind: null,
    reason: null,
  };
}

/**
 * Boolean shorthand for checking if a CAPTCHA or access restriction is active.
 */
export function isTemuCaptchaPage(document: Document): boolean {
  return detectTemuChallengeOrRestriction(document).restricted;
}

function isElementVisible(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (htmlEl.hidden || el.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  const style = htmlEl.style;
  if (
    style &&
    (style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0')
  ) {
    return false;
  }
  return true;
}
