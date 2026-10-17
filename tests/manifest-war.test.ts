/**
 * Step 6.2 (SAD-182) — M-3: web_accessible_resources must not expose the
 * whole bundle to every site. Unit-tests the WAR derivation and runs a real
 * build to assert the emitted manifest is narrowed (this is the CI assertion
 * the plan asks for).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeOverlayWarResources } from '../scripts/war-resources';

describe('M-3: computeOverlayWarResources', () => {
  it('extracts exactly the chunks/assets the overlay page references', () => {
    const html = `<!DOCTYPE html>
      <html><head>
        <link href="https://fonts.googleapis.com/css2?family=Poppins" rel="stylesheet">
        <script type="module" crossorigin src="/chunks/overlay-ABC123.js"></script>
        <link rel="modulepreload" crossorigin href="/chunks/openingMode-DEF456.js">
        <link rel="modulepreload" crossorigin href="/chunks/global-GHI789.js">
        <link rel="stylesheet" crossorigin href="/assets/global-JKL012.css">
      </head><body><div id="root"></div></body></html>`;
    expect(computeOverlayWarResources(html)).toEqual([
      'overlay.html',
      'chunks/overlay-ABC123.js',
      'chunks/openingMode-DEF456.js',
      'chunks/global-GHI789.js',
      'assets/global-JKL012.css',
    ]);
  });

  it('ignores external URLs, de-duplicates, and never emits wildcards', () => {
    const html = `
      <script src="/chunks/a-1.js"></script>
      <script src="/chunks/a-1.js"></script>
      <link href="/icon/128.png" rel="icon">
      <script src="https://evil.example.com/chunks/x.js"></script>`;
    const refs = computeOverlayWarResources(html);
    expect(refs).toEqual(['overlay.html', 'chunks/a-1.js']);
    for (const r of refs) expect(r).not.toContain('*');
  });
});

describe('M-3: built manifest is narrowed (CI assertion)', () => {
  it(
    'wxt build emits no wildcard WAR entry, https-only matches, and every entry exists',
    () => {
      const root = resolve(__dirname, '..');
      execSync('npx wxt build', { cwd: root, stdio: 'pipe', timeout: 110_000 });

      const outDir = join(root, 'dist/chrome-mv3');
      const manifest = JSON.parse(
        readFileSync(join(outDir, 'manifest.json'), 'utf8')
      );
      const war = manifest.web_accessible_resources;
      expect(Array.isArray(war)).toBe(true);

      const resources: string[] = war[0].resources;
      // the exposure being removed:
      expect(resources).not.toContain('chunks/*');
      expect(resources).not.toContain('assets/*');
      for (const r of resources) expect(r).not.toContain('*');
      // insecure origins dropped:
      expect(war[0].matches).toEqual(['https://*/*']);
      // overlay must remain embeddable, and everything listed must exist:
      expect(resources).toContain('overlay.html');
      for (const r of resources) {
        expect(existsSync(join(outDir, r)), `${r} missing from build output`).toBe(
          true
        );
      }
      // the shared bundle is only reachable through its exact hashed name —
      // i.e. the list is derived from the built overlay page:
      const overlayHtml = readFileSync(join(outDir, 'overlay.html'), 'utf8');
      for (const r of resources.slice(1)) {
        expect(overlayHtml).toContain(`/${r}`);
      }
    },
    120_000
  );
});
