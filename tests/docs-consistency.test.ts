/**
 * Docs-consistency guard (Phase 10 / L-7, SAD-152).
 *
 * "Make the invariant executable rather than documented": every claim below
 * is a fact a doc states that the code can check. When a source value
 * changes, the doc (or the doc's claim) must change with it or CI fails.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TARGET_QUICK_SELECT, TARGET_MIN, TARGET_MAX } from '@/constants/defaults';
import { AMAZON_MARKETPLACE_DOMAINS } from '@/engines/amazon/utils/amazon-url';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const README = read('README.md');
const ARCHITECTURE = read('ARCHITECTURE.md');
const CHANGELOG = read('CHANGELOG.md');
const pkg = JSON.parse(read('package.json')) as Record<string, string>;
const wxtConfig = read('wxt.config.ts');
const globalCss = read('src/entrypoints/sidepanel/global.css');

describe('docs consistency (SAD-152 / L-7)', () => {
  it("README's quick-select chips match TARGET_QUICK_SELECT", () => {
    const chips = TARGET_QUICK_SELECT.join('/'); // "50/100/200/300"
    expect(README).toContain(`(${chips})`);
    // The stale chip list must never come back.
    expect(README).not.toContain('10/50/100/250/500');
    expect(CHANGELOG).not.toContain('10/50/100/250/500');
  });

  it('README documents every permission the manifest requests (SAD-292)', () => {
    const block = wxtConfig.slice(
      wxtConfig.indexOf('permissions: ['),
      wxtConfig.indexOf(']', wxtConfig.indexOf('permissions: [')),
    );
    // Only array entries: comments inside the block also contain quoted words
    // (e.g. `conflictAction: 'uniquify'`).
    const permissions = [...block.matchAll(/^\s*'([A-Za-z]+)',\s*$/gm)].map(
      (m) => m[1]!,
    );
    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) {
      expect(README).toContain(`\`${permission}\``);
    }
  });

  it('README lists every supported marketplace (SAD-292)', () => {
    for (const domain of AMAZON_MARKETPLACE_DOMAINS) {
      expect(README).toContain(domain);
    }
  });

  it("README's target range matches TARGET_MIN/TARGET_MAX", () => {
    expect(README).toContain(`(${TARGET_MIN}–${TARGET_MAX})`);
  });

  it("every design-token hex in README's table exists in global.css", () => {
    const tableStart = README.indexOf('| Token | Light | Dark | Usage |');
    expect(tableStart).toBeGreaterThan(-1);
    const table = README.slice(tableStart, README.indexOf('**Typography:**'));
    const hexes = [...table.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => `#${m[1]!.toLowerCase()}`);
    expect(hexes.length).toBeGreaterThanOrEqual(18); // 9 tokens x light+dark
    const css = globalCss.toLowerCase();
    for (const hex of hexes) {
      expect(css, `${hex} missing from global.css`).toContain(hex);
    }
  });

  it('package.json identity is real and is the single version source', () => {
    expect(pkg.name).toBe('pphunt');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).not.toBe('0.0.0');
    expect(pkg.description).not.toContain('manifest.json description');
    // wxt.config.ts must read the version from package.json, not hardcode it.
    expect(wxtConfig).toContain('version: pkg.version');
    expect(wxtConfig).not.toMatch(/version:\s*'\d+\.\d+\.\d+'/);
  });

  it('the built manifest (when present) carries the package version', () => {
    const manifestPath = join(root, 'dist', 'chrome-mv3', 'manifest.json');
    if (!existsSync(manifestPath)) return; // build artifacts are optional in vitest
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });

  it('ARCHITECTURE describes the overlay as iframe-in-closed-shadow-root, without line counts', () => {
    expect(ARCHITECTURE).toContain('closed shadow root');
    expect(ARCHITECTURE).toContain('iframe');
    expect(ARCHITECTURE).not.toMatch(/~\d+ lines?/);
    expect(ARCHITECTURE).not.toContain('| Path | Lines |');
  });

  it('ARCHITECTURE no longer documents the phantom TOGGLE_OVERLAY message as real', () => {
    // It may only appear inside the correction note, never as a live row.
    expect(ARCHITECTURE).not.toContain('| `TOGGLE_OVERLAY` |');
  });

  it('CHANGELOG has the remediation entry with the D7 currency re-collection note', () => {
    expect(CHANGELOG).toContain('Remediation 2026-10');
    expect(CHANGELOG.toLowerCase()).toContain('re-collect');
    expect(CHANGELOG).toContain('D7');
    // Stale claims corrected:
    expect(CHANGELOG).not.toContain('(Collect | Preview | History)');
    expect(CHANGELOG).not.toContain('8 column definitions');
  });

  it('spec/06 records the notifications scope reduction', () => {
    const spec06 = read('spec/06-phase-6-settings-ui.md');
    expect(spec06).toContain('in-panel toasts only');
    expect(spec06).toContain('notifications');
  });

  it('spec/11 records the INVALID_MESSAGE behaviour and targetCount bounds', () => {
    const spec11 = read('spec/11-messaging-protocol.md');
    expect(spec11).toContain('INVALID_MESSAGE');
    expect(spec11).toContain('1–1000');
  });

  it('documented file paths still exist', () => {
    // Spot-check paths the docs point readers at (stale-path guard).
    const paths = [
      'src/lib/overlay/overlayHost.ts',
      'src/lib/db/session-state.ts',
      'src/lib/scraper/selectors.ts',
      'src/lib/scraper/parse-cache.ts',
      'src/lib/export/excel.ts',
      'src/lib/diagnostics/error-diagnosis.ts',
      'src/entrypoints/sidepanel/hooks/useFocusTrap.ts',
      'src/entrypoints/sidepanel/components/ConfirmDialog.tsx',
      'scripts/check-dead-exports.mjs',
    ];
    for (const p of paths) {
      expect(existsSync(join(root, p)), `${p} referenced by docs but missing`).toBe(true);
    }
  });
});
