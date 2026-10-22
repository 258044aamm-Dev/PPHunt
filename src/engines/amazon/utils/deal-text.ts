/**
 * SAD-387: the text stored in the Deal field is the page's own wording.
 *
 * Amazon prints a limited-time deal badge as **one label per countdown
 * granularity** — hours, minutes twice (the singular/plural branches), seconds
 * twice — and each of those carries an i18n template such as `NO_OF_MINUTES`
 * instead of a substituted value. Reading the block's `textContent` therefore
 * concatenates all of them:
 *
 *   "Limited time deal NO_OF_HOURS hours NO_OF_MINUTES minutes
 *    Limited time deal NO_OF_MINUTES minutes
 *    Limited time deal NO_OF_MINUTES minutes NO_OF_SECONDS seconds
 *    Limited time deal NO_OF_SECONDS seconds Limited time deal"
 *
 * (measured: 217 characters, 5 labels, 6 tokens — the shape reported in SAD-387).
 *
 * Operator decision D1: the value must come from the page, so nothing here maps
 * or invents wording. Templates are dropped and exact repeats collapse; a real
 * value such as `Ends in 15:00:26` or a substituted `2 hours 15 minutes` is
 * preserved exactly as printed.
 *
 * This lives in `utils/` (not in `scraper/`) because the table and the export
 * need the same rule for rows saved before the fix, and neither may import a
 * DOM module. It has no dependencies and no DOM access.
 */

/**
 * One template segment, optionally repeated back-to-back with its unit word:
 * `NO_OF_HOURS hours`, `NO_OF_MINUTES`, `NO_OF_HOURS:NO_OF_MINUTES:NO_OF_SECONDS`.
 * The trailing separator class is consumed so a clock-style template cannot
 * leave a dangling `:` behind.
 */
const TEMPLATE_SEGMENT =
  /(?:\bNO_OF_(?:HOURS?|MINUTES?|SECONDS?|DAYS?)\b(?:\s+(?:hours?|minutes?|seconds?|days?)\b)?[\s:.,\-–—]*)+/gi;

/** Separators that are meaningless at either end of a badge label. */
const EDGE_PUNCTUATION = /^[\s:.,\-–—]+|[\s:.,\-–—]+$/g;

/** Collapses a phrase that is immediately repeated ("A B A B" → "A B"). */
const REPEATED_PHRASE = /\b([A-Za-z0-9][A-Za-z0-9 '\u2019-]{2,60}?)\b(?:\s+\1\b)+/gi;

function tidy(text: string): string {
  return text
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCTUATION, '')
    .trim();
}

/**
 * Folds the repeated labels a countdown badge produces.
 *
 * Two shapes are handled: the whole string being one unit repeated (the ticket's
 * case — five copies of `Limited time deal`), and a phrase repeated immediately
 * after itself. Bounded to four passes and every pass only shortens the string,
 * so it cannot loop.
 */
function collapseRepeats(text: string): string {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = current;

    const words = current.split(' ').filter(Boolean);
    const count = words.length;
    for (let unit = 1; unit <= Math.floor(count / 2); unit += 1) {
      if (count % unit !== 0) continue;
      let repeated = true;
      for (let i = unit; i < count && repeated; i += 1) {
        if (words[i] !== words[i % unit]) repeated = false;
      }
      if (repeated) {
        current = words.slice(0, unit).join(' ');
        break;
      }
    }

    current = current.replace(REPEATED_PHRASE, '$1').trim();
    if (current === before) break;
  }
  return current;
}

/**
 * The text to store for a deal badge.
 *
 * Returns the page's text unchanged unless it contains a countdown template; a
 * text made up only of templates yields `undefined`, so no badge is invented.
 *
 * Boundary, on purpose: template-free text is returned byte for byte, even if it
 * repeats a phrase. Repetition that a human never sees is an artefact of the
 * template set, so that is the only case this rule intervenes in — which is also
 * what keeps every existing badge value (and every row already stored) stable.
 */
export function sanitizeDealBadge(
  raw: string | null | undefined,
): string | undefined {
  const text = tidy(raw ?? '');
  if (!text) return undefined;
  // Fast path — the overwhelming majority of badges never contain a template,
  // and they must keep today's value byte for byte.
  if (!/NO_OF_/i.test(text)) return text;
  return collapseRepeats(tidy(text.replace(TEMPLATE_SEGMENT, ' '))) || undefined;
}

/**
 * The value to show for a row that may have been stored before this fix (D2:
 * clean at read time, never rewrite the row).
 */
export function dealBadgeForDisplay(
  raw: string | null | undefined,
): string | null {
  return sanitizeDealBadge(raw) ?? null;
}
