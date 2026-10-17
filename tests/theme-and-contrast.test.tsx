import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/database';
import { Header } from '@/entrypoints/sidepanel/components/Header';
import { SettingsOverlay } from '@/entrypoints/sidepanel/components/SettingsOverlay';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { THEME_MODE_KEY } from '@/lib/ui/theme';

type RGB = [number, number, number];

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: RGB): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

function contrastRatio(a: RGB, b: RGB): number {
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssThemeVariables(cssBlock: string): Record<string, RGB> {
  const vars: Record<string, RGB> = {};
  const regex = /--color-([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cssBlock)) !== null) {
    vars[match[1]!] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return vars;
}

describe('WCAG 2.2 AA color contrast & theme tokens', () => {
  const cssPath = resolve(__dirname, '../src/entrypoints/sidepanel/global.css');
  const cssContent = readFileSync(cssPath, 'utf8');
  const lightBlock = cssContent.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const darkBlock = cssContent.match(/:root\.dark\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const light = parseCssThemeVariables(lightBlock);
  const dark = parseCssThemeVariables(darkBlock);

  it('meets WCAG 2.2 AA contrast thresholds in Light Mode (Warm Parchment)', () => {
    expect(contrastRatio(light['ink']!, light['canvas']!)).toBeGreaterThanOrEqual(7.0);
    expect(contrastRatio(light['ink']!, light['surface']!)).toBeGreaterThanOrEqual(7.0);
    expect(contrastRatio(light['ink']!, light['surface-card']!)).toBeGreaterThanOrEqual(7.0);

    // Secondary text (ink-muted) must pass 4.5:1 across all surfaces
    expect(contrastRatio(light['ink-muted']!, light['canvas']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['ink-muted']!, light['surface']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['ink-muted']!, light['surface-card']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['ink-muted']!, light['surface-soft']!)).toBeGreaterThanOrEqual(4.5);

    // Subtle / placeholder text (ink-subtle) must pass 4.5:1 on inputs & cards
    expect(contrastRatio(light['ink-subtle']!, light['surface']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['ink-subtle']!, light['canvas']!)).toBeGreaterThanOrEqual(4.5);

    // Primary CTA button (clay fill + clay-ink text) and clay text links
    expect(contrastRatio(light['clay']!, light['clay-ink']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['clay']!, light['canvas']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light['clay']!, light['surface']!)).toBeGreaterThanOrEqual(4.5);

    // Semantic accents (sky, moss, golden, crimson) on canvas & surface
    for (const token of ['sky', 'moss', 'golden', 'crimson'] as const) {
      expect(contrastRatio(light[token]!, light['canvas']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(light[token]!, light['surface']!)).toBeGreaterThanOrEqual(4.5);
    }

    // Interactive border (hairline) meets 3.0:1 non-text UI contrast
    expect(contrastRatio(light['hairline']!, light['surface']!)).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(light['hairline']!, light['canvas']!)).toBeGreaterThanOrEqual(3.0);
  });

  it('meets WCAG 2.2 AA contrast thresholds in Dark Mode (Warm Obsidian)', () => {
    expect(contrastRatio(dark['ink']!, dark['canvas']!)).toBeGreaterThanOrEqual(7.0);
    expect(contrastRatio(dark['ink']!, dark['surface']!)).toBeGreaterThanOrEqual(7.0);
    expect(contrastRatio(dark['ink']!, dark['surface-card']!)).toBeGreaterThanOrEqual(7.0);

    // Secondary text (ink-muted) must pass 4.5:1 across all dark surfaces
    expect(contrastRatio(dark['ink-muted']!, dark['canvas']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['ink-muted']!, dark['surface']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['ink-muted']!, dark['surface-card']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['ink-muted']!, dark['surface-soft']!)).toBeGreaterThanOrEqual(4.5);

    // Subtle / placeholder text (ink-subtle) must pass 4.5:1 on dark inputs & cards
    expect(contrastRatio(dark['ink-subtle']!, dark['surface']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['ink-subtle']!, dark['canvas']!)).toBeGreaterThanOrEqual(4.5);

    // Primary CTA button (clay fill + clay-ink text) and clay text links
    expect(contrastRatio(dark['clay']!, dark['clay-ink']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['clay']!, dark['canvas']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark['clay']!, dark['surface-card']!)).toBeGreaterThanOrEqual(4.5);

    // Semantic accents (sky, moss, golden, crimson) on dark canvas & surface
    for (const token of ['sky', 'moss', 'golden', 'crimson'] as const) {
      expect(contrastRatio(dark[token]!, dark['canvas']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark[token]!, dark['surface']!)).toBeGreaterThanOrEqual(4.5);
    }

    // Interactive border (hairline) meets 3.0:1 non-text UI contrast
    expect(contrastRatio(dark['hairline']!, dark['canvas']!)).toBeGreaterThanOrEqual(3.0);
  });
});

describe('live light and dark mode switching', () => {
  let storageData: Record<string, unknown>;
  let storageListeners: Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>;
  let mediaListeners: Set<() => void>;
  let prefersDark: boolean;

  beforeEach(async () => {
    storageData = {};
    storageListeners = new Set();
    mediaListeners = new Set();
    prefersDark = false;
    document.documentElement.classList.remove('dark');
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themeMode;

    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => ({
        get matches() {
          return prefersDark;
        },
        addEventListener: (_event: string, cb: () => void) => mediaListeners.add(cb),
        removeEventListener: (_event: string, cb: () => void) => mediaListeners.delete(cb),
      }))
    );

    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (typeof keys === 'string') return { [keys]: storageData[keys] };
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map((k) => [k, storageData[k]]));
            }
            return { ...storageData };
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(storageData, items);
            const changes = Object.fromEntries(
              Object.entries(items).map(([k, v]) => [k, { newValue: v }])
            );
            storageListeners.forEach((cb) => cb(changes, 'local'));
          }),
          remove: vi.fn(async (key: string) => {
            delete storageData[key];
            storageListeners.forEach((cb) => cb({ [key]: { newValue: undefined } }, 'local'));
          }),
        },
        onChanged: {
          addListener: vi.fn((cb) => storageListeners.add(cb)),
          removeListener: vi.fn((cb) => storageListeners.delete(cb)),
        },
      },
    });

    await db.delete();
    await db.open();
    useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    document.documentElement.classList.remove('dark');
    vi.unstubAllGlobals();
  });

  it('toggles between light and dark mode from the Header and syncs with Settings without reload', async () => {
    render(
      <StrictMode>
        <Header />
        <SettingsOverlay />
      </StrictMode>
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    const toggleBtn = screen.getByRole('button', { name: 'Switch to dark mode' });
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(storageData[THEME_MODE_KEY]).toBe('dark');
    });

    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();

    // Open Settings and verify the Dark button is selected
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByText('UI MODE', {}, { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Dark' }).className).toContain('border-ink');

    // Switch to Light inside Settings
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(storageData[THEME_MODE_KEY]).toBe('light');
      expect(screen.getByRole('button', { name: 'Light' }).className).toContain('border-ink');
    });

    // Switch back to System and verify live OS color scheme tracking
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    await waitFor(() => {
      expect(storageData[THEME_MODE_KEY]).toBeUndefined();
      expect(screen.getByRole('button', { name: 'System' }).className).toContain('border-ink');
    });

    prefersDark = true;
    act(() => {
      mediaListeners.forEach((cb) => cb());
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

/**
 * Step 6.1 (SAD-181) — H-10: token-resolution guard.
 * Tailwind silently drops utilities whose colour name exists nowhere in the
 * palette (`bg-forest`, `text-ink-faint` rendered as NO CSS at all — an
 * invisible status dot and unstyled diagnostic labels). This guard scans
 * every `bg-*` / `text-*` / `border-*` token in src/**\/*.tsx and fails on any
 * colour-looking name that resolves to nothing — the only mechanism that
 * catches this class of bug at authoring time.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

describe('H-10: every colour utility resolves to a defined token', () => {
  const configSrc = readFileSync(
    resolve(__dirname, '../tailwind.config.js'),
    'utf8'
  );
  const colorsBlock =
    configSrc.slice(
      configSrc.indexOf('colors: {'),
      configSrc.indexOf('fontFamily')
    );
  const palette = new Set(
    Array.from(colorsBlock.matchAll(/^\s*'?([a-z][a-z0-9-]*)'?:/gm), (m) => m[1]!)
  );

  // Tailwind default colours remain available through theme.extend
  const tailwindDefaults = new Set([
    'black', 'white', 'transparent', 'current', 'inherit',
    'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber',
    'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
    'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
  ]);

  // Non-colour built-in utilities sharing the same prefixes
  const builtinSuffixes: Record<string, RegExp> = {
    text: /^(xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/,
    border: /^(\d+|collapse|separate|hidden|none|dashed|dotted|solid|double|spacing|([btlresxy]|x|y)(-\d+)?)$/,
    bg: /^(none|cover|contain|center|top|bottom|left|right|fixed|local|scroll|no-repeat|repeat(-[xy])?|clip-\w+|origin-\w+|gradient-to-[trbl]){1}$/,
  };

  function resolves(prefix: string, suffix: string): boolean {
    if (suffix.startsWith('[')) return true; // arbitrary value
    // strip opacity modifier, then an optional border-side prefix
    let base = suffix.split('/')[0]!;
    if (prefix === 'border') {
      const side = base.match(/^[btlresxy]-(.+)$/);
      if (side) base = side[1]!;
    }
    if (palette.has(base)) return true;
    if (tailwindDefaults.has(base)) return true;
    return builtinSuffixes[prefix]?.test(suffix) ?? false;
  }

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.tsx') ? [full] : [];
    });
  }

  it('self-check: the resolver flags the original H-10 bugs and accepts the fixes', () => {
    expect(resolves('bg', 'forest')).toBe(false);
    expect(resolves('text', 'ink-faint')).toBe(false);
    expect(resolves('bg', 'moss')).toBe(true);
    expect(resolves('bg', 'moss/15')).toBe(true);
    expect(resolves('text', 'ink-subtle')).toBe(true);
    expect(resolves('border', 't-clay')).toBe(true);
    expect(resolves('text', 'center')).toBe(true);
    expect(resolves('bg', 'black/60')).toBe(true);
    expect(resolves('text', '[10px]')).toBe(true);
  });

  it('every bg-*/text-*/border-* token in src/**/*.tsx resolves', () => {
    const offenders: string[] = [];
    for (const file of walk(resolve(__dirname, '../src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\b(bg|text|border)-([A-Za-z0-9\[\]/().%#_,-]+)/g)) {
        if (!resolves(m[1]!, m[2]!)) {
          offenders.push(`${file.replace(/^.*\/src\//, 'src/')}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the repaired tokens exist in BOTH themes and meet contrast on the card surface', () => {
    const cssContent = readFileSync(
      resolve(__dirname, '../src/entrypoints/sidepanel/global.css'),
      'utf8'
    );
    const lightBlock = cssContent.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const darkBlock = cssContent.match(/:root\.dark\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const parse = (b: string): Record<string, [number, number, number]> => {
      const out: Record<string, [number, number, number]> = {};
      for (const m of b.matchAll(/--color-([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
        out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])];
      }
      return out;
    };
    const light = parse(lightBlock);
    const dark = parse(darkBlock);
    for (const theme of [light, dark]) {
      expect(theme['moss']).toBeDefined();
      expect(theme['ink-subtle']).toBeDefined();
      const cr = (a: [number, number, number], b: [number, number, number]) => {
        const lum = ([r, g, bl]: [number, number, number]) => {
          const lin = (c: number) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
        };
        const la = lum(a);
        const lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };
      expect(cr(theme['moss']!, theme['surface-card']!)).toBeGreaterThanOrEqual(3.0);
      // diagnostic labels (ink-subtle) — text contrast on the modal card
      expect(cr(theme['ink-subtle']!, theme['surface-card']!)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
