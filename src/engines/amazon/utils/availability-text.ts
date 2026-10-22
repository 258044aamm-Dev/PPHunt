/**
 * SAD-392: cleans availability strings stored BEFORE the write-side fix —
 * values where `textContent` reads serialized Amazon's embedded script text
 * into the field (plan §1.1/§2.1):
 *
 * - the a-state JSON `{"isInternal":false,…}` that sits inside the buybox
 *   `#availability` div on every live-captured PDP (span-less variant), and
 * - the AOD asset-loader chain `P.when("A", "load").execute(…);` from the
 *   ticket's reported variant, stored as a 1011-character blob whose tail is
 *   the real message.
 *
 * Used ONLY by the one-time Dexie v3 upgrade (`db/database.ts`) and its
 * tests — not at write time (the write side removes the cause at the DOM via
 * `extractAmazonElementText`) and not at read/display time (D2 chose a
 * migration over read hooks). Pure, DOM-free, never throws.
 */

/**
 * The same normalization table as `normalizeWhitespace` in
 * `scraper/field-parsers.ts`. Duplicated because `utils/` modules do not
 * import from `scraper/` (layering) and this module must stay dependency-free.
 */
function normalizeText(raw: string): string {
  return raw
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Script/CSS signatures measured in the wild (plan §1.1/§1.2). If a stored
 * value contains none of them it cannot hold serialized script text and is
 * returned unchanged — every clean stored row stays byte-identical. No
 * legitimate availability message observed or documented (EN/DE stock
 * phrases, shipping-restriction sentences) contains any signature.
 */
const SCRIPT_SIGNATURES: readonly string[] = [
  'P.when(',
  'function(',
  'function (',
  'ueLogError',
  'window.ue',
  'setTimeout(',
  '{color:',
  '{"',
  '":"',
  'data-a-state',
  '_namespace(',
];

/**
 * Removes every balanced `{…}` segment (a-state JSON objects, CSS rule
 * bodies, JS function bodies). String/escape-aware scanner — the technique
 * already proven in `product-detail.ts`'s `extractBalancedJsonAfterKey`.
 * An unbalanced `{` is kept verbatim: the sanitizer removes only what it can
 * prove is a complete segment, never a slice of a real message.
 */
function stripBalancedBraces(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      out += text[i];
      i += 1;
      continue;
    }
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      // Unbalanced: keep the remainder verbatim.
      out += text.slice(i);
      break;
    }
    i = end + 1;
  }
  return out;
}

/**
 * Index just past the full `P.when(…)` chain starting at `start`, or -1 when
 * unbalanced: the balanced `P.when(…)` call, every chained `.name(…)` call
 * (`.execute(…)` in the AOD loader), and one trailing `;`. Paren scanning is
 * string/escape-aware so quoted parens inside the loader body never miscount.
 */
function chainEnd(text: string, start: number): number {
  let i = start + 'P.when'.length;
  for (;;) {
    if (text[i] !== '(') return -1;
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let closed = -1;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closed = j;
          break;
        }
      }
    }
    if (closed === -1) return -1;
    i = closed + 1;
    // Follow a chained call: `.execute(…)`, `.anything(…)`.
    if (text[i] === '.') {
      let k = i + 1;
      while (k < text.length && /[A-Za-z0-9_$]/.test(text[k]!)) k += 1;
      if (k > i + 1 && text[k] === '(') {
        i = k;
        continue;
      }
    }
    break;
  }
  if (text[i] === ';') i += 1;
  return i;
}

/** Removes every complete `P.when(…)` loader chain from `text`. */
function stripPWhenChains(text: string): string {
  let out = text;
  // Bounded: each removal strictly shortens the string.
  for (let guard = 0; guard < 8; guard += 1) {
    const start = out.indexOf('P.when(');
    if (start === -1) break;
    const end = chainEnd(out, start);
    if (end === -1) break; // unbalanced: conservative, stop stripping
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/**
 * Recovers the page's own availability message from a value polluted with
 * serialized script text. Signature-gated: clean values are returned
 * byte-identical (fast path), `null`/empty normalize to `null`, and
 * script-only values with no message collapse to `null`.
 *
 * Runtime-tolerant of malformed legacy rows (e.g. `availability: 42`): a
 * non-string is returned as-is so the migration's equality check leaves the
 * row untouched instead of throwing.
 */
export function sanitizeAvailabilityText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw as unknown as string | null;

  const text = normalizeText(raw);
  if (!text) return null;

  // Fast path: no script signature can be present. Clean rows were already
  // normalized at write time (cleanAvailability = normalizeWhitespace), so
  // this is the stored string itself — byte-identical.
  if (!SCRIPT_SIGNATURES.some((signature) => text.includes(signature))) {
    return text;
  }

  let out = text;
  // Bounded fixpoint: each pass that changes anything strictly shortens the
  // string, so four passes are ample for every measured shape.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    out = stripBalancedBraces(out);
    out = stripPWhenChains(out);
    if (out === before || !out) break;
  }

  // Tidy leftover edge punctuation from partially-stripped code (';' and ','
  // only — never '.', so messages keep their sentence periods).
  out = normalizeText(out.replace(/^[;,\s]+/, '').replace(/[;,\s]+$/, ''));
  return out || null;
}
