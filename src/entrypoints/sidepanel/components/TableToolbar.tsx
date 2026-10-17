import { useCallback } from 'react';
import { formatNumber } from '@/lib/utils/formatters';

interface TableToolbarProps {
  totalCount: number;
  selectedCount: number;
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDeleteSelected: () => void;
  onExportOpen: () => void;
}

/**
 * Toolbar above the product table.
 * Contains: search input, product count, selection actions.
 */
export function TableToolbar({
  totalCount,
  selectedCount,
  globalFilter,
  onGlobalFilterChange,
  onSelectAll,
  onDeselectAll,
  onDeleteSelected,
  onExportOpen,
}: TableToolbarProps) {
  const handleClear = useCallback(() => {
    onGlobalFilterChange('');
  }, [onGlobalFilterChange]);

  return (
    <div className="flex flex-col gap-2.5 mb-3">
      {/* Search bar */}
      <div className="relative">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={globalFilter}
          onChange={(e) => onGlobalFilterChange(e.target.value)}
          placeholder="Filter by title or ASIN…"
          aria-label="Filter products by title or ASIN"
          className="w-full bg-surface border border-hairline rounded-sm text-ink placeholder:text-ink-subtle font-sans text-xs pl-8 pr-8 py-2 focus:border-ink focus:outline-none transition-colors"
        />
        {globalFilter && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink transition-colors"
            aria-label="Clear filter"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="1" y1="1" x2="13" y2="13" />
              <line x1="13" y1="1" x2="1" y2="13" />
            </svg>
          </button>
        )}
      </div>

      {/* Count + selection actions */}
      <div className="flex items-center justify-between">
        <span className="font-serif text-xs text-ink-muted">
          {formatNumber(totalCount)} product{totalCount !== 1 ? 's' : ''}
          {selectedCount > 0 && (
            <span className="text-clay font-medium ml-1">
              · {formatNumber(selectedCount)} selected
            </span>
          )}
        </span>

        {selectedCount > 0 ? (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onDeselectAll}
              className="font-sans text-xs text-ink-muted hover:text-ink transition-colors"
            >
              Deselect
            </button>
            <button
              type="button"
              onClick={onDeleteSelected}
              className="font-sans text-xs font-medium text-crimson hover:opacity-80 transition-opacity"
            >
              Delete ({selectedCount})
            </button>
          </div>
        ) : totalCount > 0 ? (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onSelectAll}
              className="font-sans text-xs text-ink-muted hover:text-ink transition-colors"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={onExportOpen}
              className="font-sans text-xs text-clay hover:text-clay-active transition-colors font-semibold"
            >
              Export
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
