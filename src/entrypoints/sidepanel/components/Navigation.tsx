import { useCallback } from 'react';
import { useUIStore, type ActiveTab } from '../store/uiStore';

const TABS: { key: ActiveTab; label: string }[] = [
  { key: 'collect', label: 'Collect' },
  { key: 'history', label: 'History' },
];

/**
 * Tab navigation: Collect | History
 * - Keyboard: Arrow Left/Right to navigate, Enter to select
 * - ARIA: role=tablist, role=tab, aria-selected, aria-controls
 * - Uses Poppins sans-serif at 13px with 500 weight
 * - Active tab: ink color + 2px clay bottom border
 */
export function Navigation() {
  const activeTab = useUIStore((s) => s.activeTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = TABS.findIndex((t) => t.key === activeTab);
      let nextIndex: number | null = null;

      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % TABS.length;
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
      }

      const nextTab = nextIndex !== null ? TABS[nextIndex] : undefined;
      if (nextTab) {
        e.preventDefault();
        setActiveTab(nextTab.key);
      }
    },
    [activeTab, setActiveTab]
  );

  return (
    <nav className="flex gap-6 mb-4 border-b border-hairline-soft" role="tablist" onKeyDown={handleKeyDown}>
      {TABS.map(({ key, label }) => {
        const isActive = activeTab === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`panel-${key}`}
            id={`tab-${key}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => setActiveTab(key)}
            className={`
              font-sans text-sm font-medium pb-2 -mb-px transition-colors
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay rounded-t-sm
              ${
                isActive
                  ? 'text-ink border-b-2 border-clay'
                  : 'text-ink-muted hover:text-ink border-b-2 border-transparent'
              }
            `}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
