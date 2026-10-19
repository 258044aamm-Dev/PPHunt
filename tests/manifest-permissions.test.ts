/**
 * SAD-278 (P1.1) - the three lists that must agree:
 * content-script `matches`, context-menu `documentUrlPatterns` and
 * `host_permissions`.
 *
 * They had drifted: 22 marketplaces in the content script, 10 in host
 * permissions, and `amazon.co.za` in neither. This suite pins the single source
 * of truth and scans the two consumers so the drift cannot come back silently.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AMAZON_HOST_PERMISSIONS,
  AMAZON_MATCH_PATTERNS,
  buildAmazonMatchPattern,
} from '@/engines/amazon/constants/match-patterns';
import { AMAZON_MARKETPLACE_DOMAINS } from '@/engines/amazon/utils/amazon-url';

const root = process.cwd();
const contentSource = readFileSync(
  join(root, 'src/entrypoints/amazon.content.ts'),
  'utf8',
);
const configSource = readFileSync(join(root, 'wxt.config.ts'), 'utf8');

describe('AMAZON_MATCH_PATTERNS', () => {
  it('builds one pattern per supported marketplace', () => {
    expect(buildAmazonMatchPattern('amazon.de')).toBe('*://*.amazon.de/*');
    expect(AMAZON_MATCH_PATTERNS).toHaveLength(AMAZON_MARKETPLACE_DOMAINS.length);
    expect(new Set(AMAZON_MATCH_PATTERNS).size).toBe(AMAZON_MATCH_PATTERNS.length);
  });

  it('covers every marketplace, including amazon.co.za', () => {
    for (const domain of AMAZON_MARKETPLACE_DOMAINS) {
      expect(AMAZON_MATCH_PATTERNS).toContain(`*://*.${domain}/*`);
    }
    expect(AMAZON_MATCH_PATTERNS).toContain('*://*.amazon.co.za/*');
  });

  it('is the same list host permissions use', () => {
    expect(AMAZON_HOST_PERMISSIONS).toEqual(AMAZON_MATCH_PATTERNS);
  });
});

describe('content script and manifest wiring', () => {
  it('the content script imports the shared list instead of hardcoding one', () => {
    expect(contentSource).toContain(
      "import { AMAZON_MATCH_PATTERNS } from '@/engines/amazon/constants/match-patterns'",
    );
    expect(contentSource).toContain('matches: [...AMAZON_MATCH_PATTERNS]');
    expect(contentSource).not.toMatch(/\*:\/\/\*\.amazon\./);
  });

  it('the manifest derives host permissions and requests contextMenus', () => {
    expect(configSource).toContain(
      "import { AMAZON_HOST_PERMISSIONS } from './src/engines/amazon/constants/match-patterns'",
    );
    expect(configSource).toContain('...AMAZON_HOST_PERMISSIONS,');
    expect(configSource).toMatch(/'contextMenus',/);
  });

  it('requests downloads for the SAD-291 export seam', () => {
    // D10: `downloads.download` is the path that works without a user gesture
    // and supports `conflictAction: 'uniquify'`; the anchor alternative has not
    // been verified in a browser yet (SAD-293).
    expect(configSource).toMatch(/'downloads',/);
  });

  it('keeps the non-Amazon host permissions that the engines rely on', () => {
    for (const pattern of [
      '*://*.media-amazon.com/*',
      '*://*.ssl-images-amazon.com/*',
      '*://*.temu.com/*',
      '*://temu.com/*',
      '*://*.kwcdn.com/*',
    ]) {
      expect(configSource).toContain(pattern);
    }
  });
});

// Optional: only meaningful after `npm run build` (vitest runs before the build
// in `npm run verify`), so it is skipped on a clean checkout instead of failing.
const manifestPath = join(root, 'dist', 'chrome-mv3', 'manifest.json');

describe('offscreen permission (SAD-295)', () => {
  it('requests the offscreen permission in the manifest config', () => {
    expect(configSource).toMatch(/'offscreen',/);
  });
});

describe.skipIf(!existsSync(manifestPath))('built manifest', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    permissions: string[];
    host_permissions: string[];
    content_scripts: { matches: string[] }[];
  };

  it('requests contextMenus', () => {
    expect(manifest.permissions).toContain('contextMenus');
  });

  it('requests offscreen and ships offscreen.html', () => {
    expect(manifest.permissions).toContain('offscreen');
    expect(existsSync(join(root, 'dist', 'chrome-mv3', 'offscreen.html'))).toBe(true);
  });

  it('gives the content script exactly the Amazon host permissions', () => {
    const amazonHosts = manifest.host_permissions.filter(
      (pattern) =>
        pattern.includes('amazon.') &&
        !pattern.includes('media-amazon') &&
        !pattern.includes('ssl-images'),
    );

    const matches = manifest.content_scripts[0]?.matches ?? [];
    expect(new Set(matches)).toEqual(new Set(amazonHosts));
    expect(matches).toContain('*://*.amazon.co.za/*');
  });
});
