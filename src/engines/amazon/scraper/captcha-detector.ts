import { safeQuerySelector, safeQuerySelectorAll } from './selectors';

export type AmazonPageIssueCode = 'CAPTCHA' | 'SIGN_IN' | 'BLOCKED';

export interface AmazonPageIssue {
  code: AmazonPageIssueCode;
  message: string;
}

export interface AmazonRestrictionResult {
  restricted: boolean;
  reason: 'captcha' | 'rate_limit' | 'dog_page' | 'sign_in' | 'none';
  message: string | null;
}

const CAPTCHA_SELECTORS: readonly string[] = [
  'form[action*="/errors/validateCaptcha"]',
  'input#captchacharacters',
  'input[name="amzn-r"]',
  '#captchacharacters',
  'img[src*="captcha" i]',
];

const SIGN_IN_SELECTORS: readonly string[] = [
  'form[name="signIn"]',
  'input#ap_email',
  'input#ap_password',
  '#authportal-main-section',
];

const DOG_PAGE_SELECTORS: readonly string[] = [
  'img[alt*="Dogs of Amazon" i]',
  'img[src*="dogs_of_amazon" i]',
  '#g > div > a > img[alt*="Sorry" i]',
];

const LOADING_INDICATOR_SELECTORS: readonly string[] = [
  '.s-result-list-placeholder',
  '.a-spinner-wrapper',
  '.a-spinner',
  '[data-component-type="s-STATUS-spinner"]',
  '.zg-loading-indicator',
];

function collectBlockAwareText(doc: Document): string {
  const root = doc.body ?? doc.documentElement;
  if (!root) return '';
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Non-bypassing page issue detector (`CAPTCHA`, `SIGN_IN`, `BLOCKED`).
 * Never attempts to solve or bypass any challenge; surfaces clear user guidance.
 */
export function detectPageIssues(
  doc: Document = document,
): AmazonPageIssue | null {
  for (const selector of CAPTCHA_SELECTORS) {
    if (safeQuerySelector(doc, selector)) {
      return {
        code: 'CAPTCHA',
        message:
          'Amazon CAPTCHA challenge detected. Please solve the challenge in your browser tab and click Resume.',
      };
    }
  }

  for (const selector of SIGN_IN_SELECTORS) {
    if (safeQuerySelector(doc, selector)) {
      return {
        code: 'SIGN_IN',
        message:
          'Amazon Sign-In prompt detected. Please sign in or return to the public listing page and click Resume.',
      };
    }
  }

  const titleText = (doc.title ?? '').trim();
  const bodyText = collectBlockAwareText(doc);
  const combined = `${titleText} ${bodyText}`;

  if (
    /Enter the characters you see below/i.test(combined) ||
    /Type the characters you see in this image/i.test(combined) ||
    /Sorry,\s*we just need to make sure you(?:'re| are) not a robot/i.test(
      combined,
    ) ||
    /Bot Check/i.test(titleText)
  ) {
    return {
      code: 'CAPTCHA',
      message:
        'Amazon robot check detected. Please complete the check in your browser tab and click Resume.',
    };
  }

  for (const selector of DOG_PAGE_SELECTORS) {
    if (safeQuerySelector(doc, selector)) {
      return {
        code: 'BLOCKED',
        message:
          'Amazon returned an error or rate-limit page (Dogs of Amazon). Please refresh the tab and try again.',
      };
    }
  }

  if (
    /api-services-support@amazon\./i.test(combined) ||
    /automated access to Amazon data/i.test(combined) ||
    /To discuss automated access to Amazon data/i.test(combined)
  ) {
    return {
      code: 'BLOCKED',
      message:
        'Amazon temporarily blocked automated requests on this page. Please wait a moment, refresh the page, and resume.',
    };
  }

  return null;
}

/**
 * Checks whether an active loading spinner or result placeholder is currently visible.
 * Ignores hidden placeholders (`.aok-hidden`, `[hidden]`, `aria-hidden="true"`).
 */
export function hasActiveLoadingIndicator(doc: Document = document): boolean {
  for (const selector of LOADING_INDICATOR_SELECTORS) {
    const elements = safeQuerySelectorAll(doc, selector);
    for (const el of elements) {
      if (
        el.classList.contains('aok-hidden') ||
        el.hasAttribute('hidden') ||
        el.getAttribute('aria-hidden') === 'true'
      ) {
        continue;
      }
      const htmlEl = el as HTMLElement;
      if (
        htmlEl.style &&
        (htmlEl.style.display === 'none' || htmlEl.style.visibility === 'hidden')
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

export function detectAmazonRestriction(
  doc: Document = document,
): AmazonRestrictionResult {
  const issue = detectPageIssues(doc);
  if (!issue) {
    return { restricted: false, reason: 'none', message: null };
  }
  const reason =
    issue.code === 'CAPTCHA'
      ? 'captcha'
      : issue.code === 'SIGN_IN'
        ? 'sign_in'
        : 'rate_limit';
  return {
    restricted: true,
    reason,
    message: issue.message,
  };
}

export function isAmazonCaptchaPage(doc: Document = document): boolean {
  return detectPageIssues(doc) !== null;
}

export const isCaptchaPage = isAmazonCaptchaPage;
