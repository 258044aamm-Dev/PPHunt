/**
 * Barrel for all wire/storage schemas (remediation Step 2.1, SAD-161).
 * `Message` is the discriminated-union type the content script and background
 * router consume — this is the export `amazon.content.ts` has been trying to
 * import since the module was written.
 */
export * from './messages';
export * from './product';
export * from './scraped-product';
export * from './settings';
export * from './validate-message';

export type { Message } from './validate-message';
