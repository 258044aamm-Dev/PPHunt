import type { ErrorCode } from '@/types/common';

export interface PageIssue {
  hasIssue: boolean;
  code: ErrorCode;
  message: string;
}

/**
 * Checks the current document for CAPTCHA, sign-in wall, or blocked page.
 * Returns null if no issues are detected.
 */
export function detectPageIssues(doc: Document): PageIssue | null {
  try {
    // 1. Check for CAPTCHA
    const captchaSelectors = [
      'form[action*="/errors/validateCaptcha"]',
      '#captchacharacters',
      'input[name="amzn"]',
      'img[src*="captcha"]',
    ];
    for (const selector of captchaSelectors) {
      if (doc.querySelector(selector)) {
        return {
          hasIssue: true,
          code: 'CAPTCHA',
          message:
            'Amazon displayed a CAPTCHA challenge form on this page. Solve the CAPTCHA in the browser tab, then click Resume to continue collection.',
        };
      }
    }

    // Also check body text for CAPTCHA indicators
    const bodyText = doc.body?.textContent?.toLowerCase() ?? '';
    if (
      bodyText.includes('type the characters you see in this image') ||
      bodyText.includes('enter the characters you see below') ||
      (bodyText.includes('not a robot') && bodyText.includes('characters'))
    ) {
      return {
        hasIssue: true,
        code: 'CAPTCHA',
        message:
          'Amazon requested automated access verification ("not a robot" challenge). Complete the prompt in the browser tab, then click Resume.',
      };
    }

    // 2. Check for sign-in wall (only if no products are on the page)
    const hasProducts =
      doc.querySelectorAll(
        'div[data-component-type="s-search-result"], #dp, #ppd, .zg-grid-general-faceout, [data-asin]:not([data-asin=""])'
      ).length > 0;

    if (!hasProducts) {
      const signInSelectors = [
        '#ap_email',
        'form[name="signIn"]',
        '#authportal-main-section',
      ];
      for (const selector of signInSelectors) {
        if (doc.querySelector(selector)) {
          return {
            hasIssue: true,
            code: 'SIGN_IN',
            message:
              'Amazon redirected this page to a Sign-In prompt. Sign in to your Amazon account in the browser tab, then click Resume.',
          };
        }
      }
    }

    // 3. Check for blocked / error / rate-limit page
    const blockedSelectors = [
      'img[alt*="Dogs of Amazon"]',
      '#g > div > a > img[alt*="Sorry"]',
      '.a-error-page',
    ];
    for (const selector of blockedSelectors) {
      if (doc.querySelector(selector)) {
        return {
          hasIssue: true,
          code: 'BLOCKED',
          message:
            'Amazon returned an error or temporary restriction page ("Dogs of Amazon") instead of product listings.',
        };
      }
    }

    const title = doc.title?.toLowerCase() ?? '';
    if (
      title.includes('503 - service unavailable') ||
      bodyText.includes('503 service unavailable') ||
      bodyText.includes('request was throttled')
    ) {
      return {
        hasIssue: true,
        code: 'RATE_LIMITED',
        message:
          'Amazon temporarily rate-limited requests (HTTP 503 Service Unavailable). Wait 30–60 seconds, then reload the tab and retry.',
      };
    }

    if (
      title.includes('sorry! something went wrong') ||
      title.includes('page not found') ||
      bodyText.includes('api-services-support@amazon.com')
    ) {
      return {
        hasIssue: true,
        code: 'BLOCKED',
        message:
          'Amazon returned an error or access-restriction page instead of product listings.',
      };
    }
  } catch (err) {
    console.warn('[PPHunt] Page issue detector error:', err);
  }

  return null;
}

/**
 * Checks whether the page currently has an active loading spinner / skeleton
 * indicating that more results are in the process of loading.
 */
export function hasActiveLoadingIndicator(doc: Document): boolean {
  try {
    const spinnerSelectors = [
      '.s-result-list-placeholder:not(.aok-hidden)',
      '.a-spinner-wrapper:not(.aok-hidden)',
      '[data-component-type="s-STATUS-RESULT"] .a-spinner',
      '.s-loading-spinner',
      '[aria-busy="true"]',
    ];
    for (const selector of spinnerSelectors) {
      if (doc.querySelector(selector)) {
        return true;
      }
    }
  } catch {
    // Ignore selector errors
  }
  return false;
}
