/**
 * SAD-290 (P5.1) - the file names.
 *
 * A filename is the one part of an export the user sees before opening it, and
 * the one part Windows and macOS disagree about. These tests pin the three
 * properties that matter: recognisable, legal everywhere, and stable (the same
 * collection exported twice gets the same name; the download layer de-dupes).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_EXPORT_FILENAME_LENGTH,
  buildCollectionExportFilename,
  sanitizeFilenameBase,
  slugifyCollectionLabel,
} from '@/engines/amazon/export/filename';

const DATE = new Date('2026-10-19T10:00:00.000Z');

describe('slugifyCollectionLabel', () => {
  it('turns a label into a lowercase ASCII slug', () => {
    expect(slugifyCollectionLabel('Writing Tools')).toBe('writing-tools');
    expect(slugifyCollectionLabel('  Kids & Baby  ')).toBe('kids-baby');
  });

  it('strips punctuation, emoji and diacritics', () => {
    expect(slugifyCollectionLabel('Café ✍️ — Tools!')).toBe('cafe-tools');
    expect(slugifyCollectionLabel('✍️🔥')).toBe('');
  });

  it('caps the slug and never ends on a separator', () => {
    const slug = slugifyCollectionLabel(`${'a'.repeat(60)} tail`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('handles a missing label', () => {
    expect(slugifyCollectionLabel(null)).toBe('');
    expect(slugifyCollectionLabel(undefined)).toBe('');
  });
});

describe('sanitizeFilenameBase', () => {
  it('removes path separators and traversal', () => {
    expect(sanitizeFilenameBase('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFilenameBase('a\\b/c')).toBe('a-b-c');
  });

  it('drops an extension the user typed into the prefix setting', () => {
    expect(sanitizeFilenameBase('my-export.csv')).toBe('my-export');
    expect(sanitizeFilenameBase('my-export.XLSX')).toBe('my-export');
  });

  it('avoids Windows reserved device names', () => {
    expect(sanitizeFilenameBase('CON')).toBe('_CON');
    expect(sanitizeFilenameBase('lpt1')).toBe('_lpt1');
  });

  it('falls back to empty for names that sanitize away', () => {
    expect(sanitizeFilenameBase('   ')).toBe('');
    expect(sanitizeFilenameBase('...')).toBe('');
  });
});

describe('buildCollectionExportFilename', () => {
  it('uses the canonical base name plus the collection slug', () => {
    expect(
      buildCollectionExportFilename({
        label: 'Writing Tools',
        count: 50,
        date: DATE,
      }),
    ).toBe('pphunt-amazon-2026-10-19-050-writing-tools');
  });

  it('omits the slug when the label has nothing usable', () => {
    expect(
      buildCollectionExportFilename({ label: '🔥', count: 3, date: DATE }),
    ).toBe('pphunt-amazon-2026-10-19-003');
  });

  it('prefers a custom prefix from settings', () => {
    expect(
      buildCollectionExportFilename({
        prefix: 'My Export',
        label: 'Office',
        count: 12,
        date: DATE,
      }),
    ).toBe('My-Export-office');
  });

  it('never exceeds 120 characters', () => {
    const name = buildCollectionExportFilename({
      prefix: 'p'.repeat(200),
      label: 'x'.repeat(200),
      count: 1,
      date: DATE,
    });
    expect(name.length).toBeLessThanOrEqual(MAX_EXPORT_FILENAME_LENGTH);
  });

  it('drops the slug rather than truncating the base', () => {
    const prefix = 'q'.repeat(MAX_EXPORT_FILENAME_LENGTH - 2);
    const name = buildCollectionExportFilename({
      prefix,
      label: 'Office',
      count: 1,
      date: DATE,
    });
    expect(name.length).toBeLessThanOrEqual(MAX_EXPORT_FILENAME_LENGTH);
    expect(name.startsWith('q')).toBe(true);
    expect(name.endsWith('office')).toBe(false);
  });

  it('is stable for the same collection, count and day', () => {
    const first = buildCollectionExportFilename({
      label: 'Office',
      count: 7,
      date: DATE,
    });
    const second = buildCollectionExportFilename({
      label: 'Office',
      count: 7,
      date: DATE,
    });
    expect(second).toBe(first);
  });

  it('handles a 200-character title without a separator at the end', () => {
    const name = buildCollectionExportFilename({
      label: 'Really Long Collection Name '.repeat(10),
      count: 50,
      date: DATE,
    });
    expect(name.length).toBeLessThanOrEqual(MAX_EXPORT_FILENAME_LENGTH);
    expect(name).not.toMatch(/[-.]$/);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });
});
