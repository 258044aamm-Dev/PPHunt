/**
 * Step 6.2 (SAD-182) — M-3: derive the web_accessible_resources list from the
 * built overlay page instead of exposing `chunks/*` + `assets/*` to every
 * site (which let any website probe the 919 kB bundle and fingerprint the
 * exact extension version).
 *
 * The overlay's JS/CSS filenames are content-hashed and change every build,
 * so the WAR list is regenerated post-build (wxt.config.ts `build:done` hook)
 * from exactly the resources `overlay.html` references.
 */

/**
 * Extracts every extension-local chunk/asset the overlay page loads
 * (`<script src>`, `<link rel="modulepreload">`, `<link rel="stylesheet">`)
 * and returns them as manifest-relative paths, `overlay.html` first.
 */
export function computeOverlayWarResources(overlayHtml: string): string[] {
  const refs = new Set<string>();
  const pattern = /(?:src|href)="\/((?:chunks|assets)\/[^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(overlayHtml)) !== null) {
    refs.add(match[1]!);
  }
  return ['overlay.html', ...refs];
}
