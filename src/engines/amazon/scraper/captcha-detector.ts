import { safeQuerySelector } from './selectors';

export type AmazonRestrictionReason =
  | 'captcha'
  | 'dog_page'
  | 'rate_limited'
  | 'none';

export interface AmazonRestrictionStatus {
  isBlocked: boolean;
  reason: AmazonRestrictionReason;
  message?: string;
}

const CAPTCHA_ELEMENT_SELECTORS: readonly string[] = [
  'form[action*="/errors/validateCaptcha"]',
  'input#captchacharacters',
  '#captchacharacters',
  '#opfcaptcha',
  'img[src*="captcha" i]',
  'input[name="amzn-r"]',
];

const DOG_PAGE_SELECTORS: readonly string[] = [
  'img[alt*="Dogs of Amazon" i]',
  'a[href*="/dogsofamazon" i]',
  'img[src*="images-na.ssl-images-amazon.com/images/G/01/error/"]',
];

const CAPTCHA_TEXT_PATTERNS: readonly RegExp[] = [
  /enter the characters you see below/i,
  /type the characters you see in this image/i,
  /sorry,\s*we just need to make sure you're not a robot/i,
  /geben sie die zeichen unten ein/i,
  /saisissez les caractères que vous voyez ci-dessous/i,
];

const RATE_LIMIT_TEXT_PATTERNS: readonly RegExp[] = [
  /automated access to amazon data/i,
  /to discuss automated access to amazon data please contact/i,
  /api-services-support@amazon\.com/i,
];

const DOG_PAGE_TEXT_PATTERNS: readonly RegExp[] = [
  /sorry!\s*something went wrong on our end/i,
  /sorry!\s*we couldn't find that page/i,
];

/**
 * Inspects the document for Amazon CAPTCHA challenges, automated-access rate limits,
 * or "Dogs of Amazon" error pages. Never attempts to bypass or solve any challenge.
 */
export function detectAmazonRestriction(
  doc?: Document | null,
): AmazonRestrictionStatus {
  const activeDoc =
    doc ?? (typeof document !== 'undefined' ? document : null);
  if (!activeDoc) {
    return { isBlocked: false, reason: 'none' };
  }

  for (const selector of CAPTCHA_ELEMENT_SELECTORS) {
    if (safeQuerySelector(activeDoc, selector)) {
      return {
        isBlocked: true,
        reason: 'captcha',
        message:
          'Amazon CAPTCHA challenge detected. Please solve the challenge in the browser tab and resume.',
      };
    }
  }

  for (const selector of DOG_PAGE_SELECTORS) {
    if (safeQuerySelector(activeDoc, selector)) {
      return {
        isBlocked: true,
        reason: 'dog_page',
        message: 'Amazon returned an error ("Dogs of Amazon") page.',
      };
    }
  }

  // Only inspect page-level text when the page has no main product containers
  const hasProductContent = Boolean(
    safeQuerySelector(
      activeDoc,
      '[data-component-type="s-search-result"][data-asin], #productTitle, #gridItemRoot, [data-p13n-asin-metadata]',
    ),
  );

  if (!hasProductContent) {
    const bodyText =
      activeDoc.body?.textContent ??
      activeDoc.documentElement?.textContent ??
      '';
    const titleText = activeDoc.title ?? '';
    const combinedText = `${titleText} ${bodyText}`.slice(0, 8000);

    for (const pattern of CAPTCHA_TEXT_PATTERNS) {
      if (pattern.test(combinedText)) {
        return {
          isBlocked: true,
          reason: 'captcha',
          message:
            'Amazon CAPTCHA verification page detected. Please complete verification in the tab.',
        };
      }
    }

    for (const pattern of RATE_LIMIT_TEXT_PATTERNS) {
      if (pattern.test(combinedText)) {
        return {
          isBlocked: true,
          reason: 'rate_limited',
          message:
            'Amazon temporarily throttled automated requests on this page.',
        };
      }
    }

    for (const pattern of DOG_PAGE_TEXT_PATTERNS) {
      if (pattern.test(combinedText)) {
        return {
          isBlocked: true,
          reason: 'dog_page',
          message: 'Amazon returned a temporary error page.',
        };
      }
    }
  }

  return { isBlocked: false, reason: 'none' };
}

/**
 * Returns `true` when the document is an Amazon CAPTCHA or automated-access challenge page.
 */
export function isAmazonCaptchaPage(doc?: Document | null): boolean {
  const status = detectAmazonRestriction(doc);
  return status.reason === 'captcha' || status.reason === 'rate_limited';
}

export const isCaptchaPage = isAmazonCaptchaPage;
