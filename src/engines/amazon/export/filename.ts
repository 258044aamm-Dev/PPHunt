import { buildExportFilename } from './types';

/**
 * SAD-290 (plan 11.1): what the file is called.
 *
 * Three constraints pull in different directions: the name has to be recognisable
 * (`pphunt-amazon-2026-10-19-050-writing-tools`), it has to be legal on both
 * Windows and macOS, and it has to stay short enough for a browser download
 * dialog. The base name is never truncated - it carries the date and the count -
 * only the collection slug gives way, and only after everything non-ASCII has
 * already been removed.
 *
 * Uniqueness is deliberately *not* handled here: exporting the same unchanged
 * collection twice must produce the same name, and the download layer resolves
 * the collision with `conflictAction: 'uniquify'` (plan 11.2). A random suffix
 * here would make the name unpredictable without making the file any more unique.
 */

export const MAX_EXPORT_FILENAME_LENGTH = 120;
export const MAX_COLLECTION_SLUG_LENGTH = 40;

/** Windows refuses these names even with an extension. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * A short, ASCII-only, hyphen-separated form of a collection label.
 * Emoji, punctuation and scripts without an ASCII decomposition disappear.
 */
export function slugifyCollectionLabel(label: string | null | undefined): string {
  if (typeof label !== 'string') return '';

  const ascii = label
    .normalize('NFKD')
    // Combining marks left behind by the decomposition above.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!ascii) return '';
  return ascii.slice(0, MAX_COLLECTION_SLUG_LENGTH).replace(/-+$/g, '');
}

/**
 * Makes an arbitrary user-supplied prefix safe to hand to a download API: no
 * directories, no separators, no trailing dots or spaces (both invalid on
 * Windows), and never a reserved device name.
 */
export function sanitizeFilenameBase(input: string): string {
  const stripped = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Drop a file extension the user typed into the prefix setting.
    .replace(/\.(csv|xlsx|txt)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '');

  if (!stripped || stripped === '.' || stripped === '..') return '';
  if (WINDOWS_RESERVED.has(stripped.toLowerCase())) return `_${stripped}`;
  return stripped;
}

export interface CollectionExportFilenameInput {
  /** Collection label; omitted or empty means "no slug". */
  label?: string | null;
  /** Row count, used for the `NNN` segment of the default base name. */
  count: number;
  date?: Date;
  /** `settings.exportFilename`, when the user has set one. */
  prefix?: string | null;
}

/**
 * `<prefix|pphunt-amazon-YYYY-MM-DD-NNN>[-<slug>]`, capped at 120 characters.
 * The result never contains a path separator and is safe to append `.csv`/`.xlsx`.
 */
export function buildCollectionExportFilename(
  input: CollectionExportFilenameInput,
): string {
  const fallback = buildExportFilename(input.count, input.date ?? new Date());
  const base = sanitizeFilenameBase(input.prefix ?? '') || fallback;
  const slug = slugifyCollectionLabel(input.label);

  if (!slug) {
    return base.slice(0, MAX_EXPORT_FILENAME_LENGTH);
  }

  const separator = '-';
  const room =
    MAX_EXPORT_FILENAME_LENGTH - base.length - separator.length;

  if (room <= 0) {
    // A very long custom prefix wins over the slug: the date/count part is what
    // makes two downloads distinguishable, the slug is only a hint.
    return base.slice(0, MAX_EXPORT_FILENAME_LENGTH);
  }

  return `${base}${separator}${slug.slice(0, room).replace(/-+$/g, '')}`;
}
