import type { PreviewDisplayMode } from '@/lib/preview/previewStateSync';

interface PreviewModeSwitcherProps {
  currentMode: PreviewDisplayMode;
  onSelectMode: (mode: PreviewDisplayMode) => void;
}

const PREVIEW_MODES: ReadonlyArray<{
  id: PreviewDisplayMode;
  label: string;
  description: string;
}> = [
  {
    id: 'sidebar',
    label: 'Sidebar',
    description: 'Compact 400px Side Panel / Page Drawer preview',
  },
  {
    id: 'overview',
    label: 'Overview',
    description: 'Expanded 95vw full-width overlay preview',
  },
  {
    id: 'tab',
    label: 'Tab',
    description: 'Dedicated full-screen browser tab (/preview.html)',
  },
];

/**
 * 3-way segmented mode switcher (`Sidebar` | `Overview` | `Tab`) allowing
 * users to seamlessly switch between the compact 400px sidebar preview,
 * the 95vw full-width overview overlay, and the dedicated browser tab preview.
 */
export function PreviewModeSwitcher({
  currentMode,
  onSelectMode,
}: PreviewModeSwitcherProps) {
  return (
    <div
      role="group"
      aria-label="Preview display mode"
      data-testid="preview-mode-switcher"
      className="inline-flex items-center rounded-sm border border-hairline bg-surface p-0.5 gap-0.5"
    >
      {PREVIEW_MODES.map((mode) => {
        const isActive = currentMode === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={isActive}
            data-testid={`preview-mode-${mode.id}`}
            title={mode.description}
            onClick={() => onSelectMode(mode.id)}
            className={`px-2.5 py-1 rounded-sm font-sans text-xs font-medium transition-colors cursor-pointer ${
              isActive
                ? 'bg-clay text-clay-ink font-semibold'
                : 'text-ink-muted hover:text-ink hover:bg-surface-soft'
            }`}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
