import { AMAZON_SELECTORS } from '../scraper/selectors';

/** SAD-389: keep the existing child-list feed; add only target text/visibility. */
export const AMAZON_COLLECTION_OBSERVER_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeOldValue: true,
  attributeFilter: ['class', 'style', 'hidden'],
};

const CARD = '[data-component-type="s-search-result"], [data-asin], #gridItemRoot, .zg-grid-general-faceout, [data-testid="product-card"]';
const TARGET = [...AMAZON_SELECTORS.cardFields.coupon, '#social-proofing-faceout-title-tk_bought'].join(',');
const MONTHLY_TEXT = /bought\s+in\s+past\s+month/i;
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))(?:\s*!important)?\s*(?:;|$)/i;

function targetClasses(value: string | null): string {
  return (value ?? '').split(/\s+/).filter(c => /coupon|^aok-hidden$|^a-hidden$/i.test(c)).sort().join(' ');
}

/** Exported so native-browser QA exercises the actual production predicate. */
export function isRelevantAmazonCollectionMutation(m: MutationRecord): boolean {
  const el = m.target.nodeType === 1 ? m.target as Element : m.target.parentElement;
  if (!el) return false;
  // Preserve the old carousel rule and ignore our own light-DOM controls.
  if (el.closest('[data-pphunt-save-host]')) return false;
  if (el.closest('.a-carousel-card') && !el.closest('.s-main-slot')) return false;
  if (m.type === 'childList' && m.addedNodes.length > 0) return true;

  const card = el.closest(CARD);
  if (!card) return false;

  if (m.type === 'attributes') {
    // Hover, animations, shipping counters and unrelated style churn must not
    // turn the new attribute subscription into an all-page scrape loop.
    if (m.attributeName === 'class') {
      if (targetClasses(m.oldValue) === targetClasses(el.getAttribute('class'))) return false;
    } else if (m.attributeName === 'style') {
      if (HIDDEN_STYLE.test(m.oldValue ?? '') === HIDDEN_STYLE.test(el.getAttribute('style') ?? '')) return false;
    } else if (m.attributeName === 'hidden') {
      if ((m.oldValue !== null) === el.hasAttribute('hidden')) return false;
    } else {
      return false;
    }
    return Boolean(el.closest(TARGET) || el.querySelector(TARGET) || MONTHLY_TEXT.test(el.textContent ?? ''));
  }

  // Text.data changes do not create addedNodes. Walk only short local parents
  // so a split count/phrase badge works without treating all card text as a
  // signal (e.g. a shipping-counter update next to an unchanged sales badge).
  if (el.closest(TARGET)) return true;
  for (let local: Element | null = el; local && local !== card; local = local.parentElement) {
    const text = local.textContent ?? '';
    if (text.length <= 240 && MONTHLY_TEXT.test(text)) return true;
  }
  return false;
}
