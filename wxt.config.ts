import { defineConfig } from 'wxt';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeOverlayWarResources } from './scripts/war-resources';

// Phase 10 (L-7): package.json is the single source of truth for the version —
// the manifest reads it here, and tests/docs-consistency.test.ts pins the pair.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { name: string; version: string; description: string };

export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: 'PPHunt',
    description: 'Collect, preview, and export Amazon product data with care.',
    version: pkg.version,
    permissions: [
      'sidePanel',
      'activeTab',
      'tabs',
      'storage',
      'scripting',
    ],
    host_permissions: [
      '*://*.amazon.com/*',
      '*://*.amazon.co.uk/*',
      '*://*.amazon.de/*',
      '*://*.amazon.fr/*',
      '*://*.amazon.ca/*',
      '*://*.amazon.co.jp/*',
      '*://*.amazon.in/*',
      '*://*.amazon.com.au/*',
      '*://*.amazon.es/*',
      '*://*.amazon.it/*',
      '*://*.media-amazon.com/*',
      '*://*.ssl-images-amazon.com/*',
      '*://*.temu.com/*',
      '*://temu.com/*',
      '*://*.kwcdn.com/*',
    ],
    // M-3 (SAD-182): only the overlay page and its own bundles are embeddable
    // on ordinary sites. The old wildcards ('chunks/*', 'assets/*' for
    // http+https) exposed the 919 kB shared bundle and compiled CSS to every
    // website, enabling extension detection and version fingerprinting.
    // The static list is minimal on purpose; the `build:done` hook below
    // rewrites it to exactly the hashed chunks/assets overlay.html references.
    // `http://*/*` is dropped: Amazon redirects to HTTPS, and plain-HTTP
    // embeddability should be an explicit decision, not a wildcard default.
    web_accessible_resources: [{
      resources: ['overlay.html'],
      matches: ['https://*/*'],
    }],
    action: {
      default_popup: 'popup/index.html',
      default_icon: {
        '16': 'icon/16.png',
        '32': 'icon/32.png',
        '48': 'icon/48.png',
        '96': 'icon/96.png',
        '128': 'icon/128.png',
      },
    },
    icons: {
      '16': 'icon/16.png',
      '32': 'icon/32.png',
      '48': 'icon/48.png',
      '96': 'icon/96.png',
      '128': 'icon/128.png',
    },
  },

  hooks: {
    // M-3 (SAD-182): post-build, replace the minimal static WAR list with
    // exactly the content-hashed chunks/assets the built overlay.html loads.
    // Hashes rotate every build, so enumeration cannot live in the static
    // config — this hook is the generation step.
    'build:done': async (wxt) => {
      const outDir = wxt.config.outDir;
      const overlayPath = join(outDir, 'overlay.html');
      const manifestPath = join(outDir, 'manifest.json');
      try {
        const overlayHtml = readFileSync(overlayPath, 'utf8');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const war = manifest.web_accessible_resources?.[0];
        if (!war) return;
        war.resources = computeOverlayWarResources(overlayHtml);
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        wxt.logger.success(
          `[WAR] narrowed web_accessible_resources to ${war.resources.length} entries`
        );
      } catch (err) {
        // Never fail the build for the hardening pass — but make it loud.
        wxt.logger.warn('[WAR] could not narrow web_accessible_resources:', err);
      }
    },
  },
});