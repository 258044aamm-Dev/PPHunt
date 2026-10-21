import { useCallback, useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  OPENING_MODE_KEY,
  readOpeningMode,
  type OpeningMode,
} from '@/lib/ui/openingMode';
import {
  THEME_MODE_KEY,
  readThemeMode,
  setThemePreference,
  applyTheme,
  type ThemeMode,
} from '@/lib/ui/theme';
import { modalAriaProps } from '@/lib/utils/a11y';
import { useConfirmDialog } from '@/entrypoints/sidepanel/components/ConfirmDialog';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';
import {
  TEMU_ALL_EXPORT_COLUMNS,
  TEMU_TARGET_MAX,
  TEMU_TARGET_MIN,
} from '../../constants/defaults';
import { temuDb } from '../../db/database';
import type { TemuUserSettings } from '../../types';
import { useTemuSettings } from '../hooks/useTemuSettings';
import { useTemuUIStore } from '../store/uiStore';

export function TemuSettingsOverlay() {
  const { askConfirm, confirmDialog } = useConfirmDialog();
  const settingsOpen = useTemuUIStore((s) => s.settingsOpen);
  const closeSettings = useTemuUIStore((s) => s.closeSettings);
  const focusTrapRef = useFocusTrap<HTMLDivElement>(settingsOpen, closeSettings);
  const { settings, isLoading, updateSettings, restoreDefaults } =
    useTemuSettings();

  const productCount = useLiveQuery(() => temuDb.products.count(), []) ?? 0;
  const sessionCount = useLiveQuery(() => temuDb.sessions.count(), []) ?? 0;

  const [uiMode, setUiMode] = useState<OpeningMode | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [overlayWidth, setOverlayWidth] = useState(400);

  useEffect(() => {
    let mounted = true;
    const changedKeys = new Set<string>();
    void browser.storage.local
      .get([OPENING_MODE_KEY, 'pphuntOverlayWidth', THEME_MODE_KEY])
      .then((stored) => {
        if (!mounted) return;
        if (!changedKeys.has(OPENING_MODE_KEY)) {
          setUiMode(readOpeningMode(stored?.[OPENING_MODE_KEY]));
        }
        if (!changedKeys.has(THEME_MODE_KEY)) {
          const loadedTheme = readThemeMode(stored?.[THEME_MODE_KEY]);
          setThemeMode(loadedTheme);
          applyTheme(loadedTheme);
        }
        if (
          !changedKeys.has('pphuntOverlayWidth') &&
          typeof stored?.pphuntOverlayWidth === 'number' &&
          Number.isFinite(stored.pphuntOverlayWidth)
        ) {
          setOverlayWidth(
            Math.max(300, Math.min(800, stored.pphuntOverlayWidth))
          );
        }
      });
    const onChange = (
      changes: Record<string, { newValue?: unknown }>,
      area: string
    ) => {
      if (area !== 'local') return;
      if (changes[OPENING_MODE_KEY]) {
        changedKeys.add(OPENING_MODE_KEY);
        setUiMode(readOpeningMode(changes[OPENING_MODE_KEY].newValue));
      }
      if (changes[THEME_MODE_KEY]) {
        changedKeys.add(THEME_MODE_KEY);
        const nextTheme = readThemeMode(changes[THEME_MODE_KEY].newValue);
        setThemeMode(nextTheme);
        applyTheme(nextTheme);
      }
      const width = changes.pphuntOverlayWidth?.newValue;
      if (typeof width === 'number' && Number.isFinite(width)) {
        changedKeys.add('pphuntOverlayWidth');
        setOverlayWidth(Math.max(300, Math.min(800, width)));
      }
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      mounted = false;
      browser.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const handleUiModeChange = useCallback(async (mode: OpeningMode | null) => {
    if (mode === null) await browser.storage.local.remove(OPENING_MODE_KEY);
    else await browser.storage.local.set({ [OPENING_MODE_KEY]: mode });
    setUiMode(mode);
  }, []);

  const handleThemeChange = useCallback(async (mode: ThemeMode) => {
    setThemeMode(mode);
    await setThemePreference(mode);
  }, []);

  const handleRestoreDefaults = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Restore defaults?',
      message:
        'Restore all Temu engine settings to defaults? This cannot be undone.',
      confirmLabel: 'Restore',
      tone: 'danger',
    });
    if (!ok) return;
    await restoreDefaults();
  }, [restoreDefaults, askConfirm]);

  if (!settingsOpen) return null;
  if (isLoading || !settings) {
    return (
      <div className="fixed inset-0 z-40 flex">
        <div
          className="absolute inset-0 bg-ink/40 dark:bg-black/60"
          onClick={closeSettings}
        />
        <div className="relative ml-auto w-full max-w-sm bg-surface-card border-l border-hairline-soft flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-hairline-soft border-t-clay rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  const enabledColumnSet = new Set(settings.defaultExportColumns);

  const toggleColumn = (key: string, checked: boolean) => {
    const next = new Set(settings.defaultExportColumns);
    if (checked) next.add(key);
    else next.delete(key);
    updateSettings({ defaultExportColumns: Array.from(next) });
  };

  return (
    <div
      ref={focusTrapRef}
      tabIndex={-1}
      {...modalAriaProps('temu-settings-overlay-title')}
      className="fixed inset-0 z-40 flex transition-opacity duration-200"
    >
      <div
        className="absolute inset-0 bg-ink/40 dark:bg-black/60"
        onClick={closeSettings}
      />

      <div className="relative ml-auto w-full max-w-sm bg-surface-card border-l border-hairline-soft overflow-y-auto animate-slide-in">
        <div className="sticky top-0 z-10 bg-surface-card border-b border-hairline-soft">
          <button
            onClick={closeSettings}
            className="flex items-center gap-2.5 p-4 w-full text-left hover:bg-surface-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-ink"
            >
              <line x1="13" y1="7" x2="1" y2="7" />
              <polyline points="6,2 1,7 6,12" />
            </svg>
            <span
              id="temu-settings-overlay-title"
              className="font-serif text-base font-semibold text-ink"
            >
              Settings
            </span>
          </button>
        </div>

        <div className="p-4 space-y-0">
          <SettingsSection title="UI MODE">
            <div className="space-y-4">
              <div>
                <label className="font-sans text-xs font-medium text-ink block mb-2">
                  Default opening behavior
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { mode: null, label: 'Ask Every Time' },
                      { mode: 'sidePanel', label: 'Side Panel' },
                      { mode: 'overlay', label: 'Page Overlay' },
                    ] as const
                  ).map(({ mode, label }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        void handleUiModeChange(mode);
                      }}
                      className={`
                        px-2 py-2 font-sans text-xs rounded-sm border transition-colors
                        ${
                          uiMode === mode
                            ? 'bg-surface text-ink border-ink font-medium'
                            : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                        }
                      `}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="font-sans text-xs font-medium text-ink block mb-2">
                  Theme
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { mode: 'system', label: 'System' },
                      { mode: 'light', label: 'Light' },
                      { mode: 'dark', label: 'Dark' },
                    ] as const
                  ).map(({ mode, label }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        void handleThemeChange(mode);
                      }}
                      className={`
                        px-2 py-2 font-sans text-xs rounded-sm border transition-colors
                        ${
                          themeMode === mode
                            ? 'bg-surface text-ink border-ink font-medium'
                            : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                        }
                      `}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="font-sans text-xs font-medium text-ink block mb-2">
                  Overlay default width{' '}
                  <span className="text-ink-muted font-normal">(px)</span>
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={300}
                    max={800}
                    step={10}
                    value={overlayWidth}
                    onChange={(event) => {
                      const width = Number(event.target.value);
                      setOverlayWidth(width);
                      void browser.storage.local.set({
                        pphuntOverlayWidth: width,
                      });
                    }}
                    className="flex-1 accent-clay h-1.5 cursor-pointer"
                  />
                  <span className="font-mono text-xs text-ink-muted w-12 text-right">
                    {overlayWidth}
                  </span>
                </div>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="GENERAL">
            <div className="space-y-4">
              <div>
                <label className="font-sans text-xs font-medium text-ink block mb-2">
                  Default Mode
                </label>
                <div className="flex gap-2">
                  {(['manual', 'automatic'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => updateSettings({ defaultMode: mode })}
                      className={`
                        flex-1 px-3 py-2 font-sans text-xs rounded-sm border transition-colors
                        ${
                          settings.defaultMode === mode
                            ? 'bg-surface text-ink border-ink font-medium'
                            : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                        }
                      `}
                    >
                      {mode === 'manual' ? 'Manual' : 'Automatic'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="font-sans text-xs font-medium text-ink block mb-2">
                  Default Target Count
                </label>
                <input
                  type="number"
                  min={TEMU_TARGET_MIN}
                  max={TEMU_TARGET_MAX}
                  value={settings.defaultTargetCount}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (
                      !isNaN(v) &&
                      v >= TEMU_TARGET_MIN &&
                      v <= TEMU_TARGET_MAX
                    ) {
                      updateSettings({ defaultTargetCount: v });
                    }
                  }}
                  className="w-full bg-surface border border-hairline rounded-sm text-ink font-mono text-xs px-3 py-2 focus:border-ink focus:outline-none transition-colors"
                />
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="AUTOMATIC SCROLLING">
            <div className="space-y-4">
              <SliderSetting
                label="Scroll Amount"
                unit="px"
                min={200}
                max={2000}
                step={50}
                value={settings.scrollAmount}
                onChange={(v) => updateSettings({ scrollAmount: v })}
              />
              <SliderSetting
                label="Scroll Interval"
                unit="ms"
                min={500}
                max={5000}
                step={100}
                value={settings.scrollInterval}
                onChange={(v) => updateSettings({ scrollInterval: v })}
              />
              <SliderSetting
                label="Wait After Scroll"
                unit="ms"
                min={500}
                max={5000}
                step={100}
                value={settings.waitAfterScroll}
                onChange={(v) => updateSettings({ waitAfterScroll: v })}
              />
            </div>
          </SettingsSection>

          <SettingsSection title="DATA FIELDS">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {TEMU_ALL_EXPORT_COLUMNS.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={enabledColumnSet.has(key)}
                    onChange={(e) => toggleColumn(key, e.target.checked)}
                    className="w-3.5 h-3.5 accent-clay cursor-pointer"
                  />
                  <span className="font-sans text-xs text-ink">{label}</span>
                </label>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection title="BEHAVIOR">
            <div className="space-y-3">
              <ToggleSetting
                label="Duplicate detection"
                description="Skip products with Goods IDs already collected"
                checked={settings.duplicateDetection}
                onChange={(v) => updateSettings({ duplicateDetection: v })}
              />
              <ToggleSetting
                label="Notifications"
                description="Show toasts for events like target reached"
                checked={settings.soundNotifications}
                onChange={(v) => updateSettings({ soundNotifications: v })}
              />
              <ToggleSetting
                label="Expand product details"
                description="Click 'See all details' before extracting features and description"
                checked={settings.expandProductDetails}
                onChange={(v) => updateSettings({ expandProductDetails: v })}
              />
            </div>
          </SettingsSection>

          <SettingsSection title="EXPORT DEFAULTS">
            <div className="space-y-3">
              <div>
                <label className="font-sans text-xs font-medium text-ink block mb-1.5">
                  Format
                </label>
                <select
                  value={settings.defaultExportFormat}
                  onChange={(e) =>
                    updateSettings({
                      defaultExportFormat: e.target
                        .value as TemuUserSettings['defaultExportFormat'],
                    })
                  }
                  className="w-full bg-surface border border-hairline rounded-sm text-ink font-sans text-xs px-3 py-2 focus:border-ink focus:outline-none transition-colors"
                >
                  <option value="csv">CSV</option>
                  <option value="xlsx">Excel (.xlsx)</option>
                  <option value="clipboard">Clipboard</option>
                </select>
              </div>
              <div>
                <label className="font-sans text-xs font-medium text-ink block mb-1.5">
                  Embed images (Excel)
                </label>
                <select
                  value={settings.exportImageBudget}
                  onChange={(e) =>
                    updateSettings({
                      exportImageBudget: e.target
                        .value as TemuUserSettings['exportImageBudget'],
                    })
                  }
                  className="w-full bg-surface border border-hairline rounded-sm text-ink font-sans text-xs px-3 py-2 focus:border-ink focus:outline-none transition-colors"
                >
                  <option value="default">Auto (budgeted)</option>
                  <option value="always">Always embed</option>
                  <option value="never">Never (URLs only)</option>
                </select>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="DATA">
            <div className="space-y-2 mb-1">
              <div className="flex items-center justify-between font-sans text-xs">
                <span className="text-ink-muted">Temu products stored</span>
                <span className="font-mono text-ink font-medium">
                  {productCount}
                </span>
              </div>
              <div className="flex items-center justify-between font-sans text-xs">
                <span className="text-ink-muted">Temu sessions</span>
                <span className="font-mono text-ink font-medium">
                  {sessionCount}
                </span>
              </div>
            </div>
          </SettingsSection>

          <div className="pt-4 pb-6">
            <button
              type="button"
              onClick={handleRestoreDefaults}
              className="w-full px-4 py-2.5 font-sans text-xs font-medium text-crimson border border-crimson/50 rounded-sm hover:bg-crimson/10 transition-colors"
            >
              Restore Default Settings
            </button>
          </div>
        </div>
      </div>

      {confirmDialog}
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="py-4 border-b border-hairline-soft">
      <h3 className="font-sans text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">
        {title}
      </h3>
      {children}
    </section>
  );
}

function SliderSetting({
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="font-sans text-xs text-ink">{label}</label>
        <span className="font-mono text-xs text-ink-muted">
          {value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-clay h-1.5 cursor-pointer"
      />
    </div>
  );
}

function ToggleSetting({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5 accent-clay cursor-pointer mt-0.5 shrink-0"
      />
      <div>
        <span className="font-sans text-xs font-medium text-ink block">
          {label}
        </span>
        {description && (
          <span className="font-serif text-xs text-ink-muted leading-relaxed">
            {description}
          </span>
        )}
      </div>
    </label>
  );
}
