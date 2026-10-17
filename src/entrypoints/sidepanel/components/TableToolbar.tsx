import { useCallback } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { formatNumber } from '@/lib/utils/formatters';
import {
  getSortPresetsForEngine,
  getSortableFieldsForEngine,
  matchSortPresetId,
} from '@/lib/sorting/product-sorter';

interface TableToolbarProps {
  totalCount: number;
  selectedCount: number;
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDeleteSelected: () => void;
  onExportOpen: () => void;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  engine?: 'amazon' | 'temu';
}

/**
 * Toolbar above the product table.
 * Contains: search input, preset & multi-column sort controls, product count, and selection actions.
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
  sorting = [],
  onSortingChange,
  engine = 'amazon',
}: TableToolbarProps) {
  const presets = getSortPresetsForEngine(engine);
  const sortableFields = getSortableFieldsForEngine(engine);
  const activePresetId = matchSortPresetId(sorting, engine);

  const handleClear = useCallback(() => {
    onGlobalFilterChange('');
  }, [onGlobalFilterChange]);

  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!onSortingChange) return;
      const presetId = e.target.value;
      const found = presets.find((p) => p.id === presetId);
      if (found) {
        onSortingChange([...found.sorting]);
      }
    },
    [onSortingChange, presets],
  );

  const handleAddSortField = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!onSortingChange) return;
      const fieldId = e.target.value;
      if (!fieldId) return;
      const fieldMeta = sortableFields.find((f) => f.id === fieldId);
      const defaultDesc = fieldMeta?.defaultDesc ?? false;
      if (sorting.some((s) => s.id === fieldId)) return;
      onSortingChange([...sorting, { id: fieldId, desc: defaultDesc }]);
    },
    [onSortingChange, sortableFields, sorting],
  );

  const handleToggleSortDirection = useCallback(
    (fieldId: string) => {
      if (!onSortingChange) return;
      onSortingChange(
        sorting.map((rule) =>
          rule.id === fieldId ? { ...rule, desc: !rule.desc } : rule,
        ),
      );
    },
    [onSortingChange, sorting],
  );

  const handleRemoveSortRule = useCallback(
    (fieldId: string) => {
      if (!onSortingChange) return;
      onSortingChange(sorting.filter((rule) => rule.id !== fieldId));
    },
    [onSortingChange, sorting],
  );

  const handleResetSort = useCallback(() => {
    onSortingChange?.([]);
  }, [onSortingChange]);

  const remainingSortableFields = sortableFields.filter(
    (field) => !sorting.some((s) => s.id === field.id),
  );

  const getFieldLabel = (fieldId: string): string =>
    sortableFields.find((f) => f.id === fieldId)?.label ?? fieldId;

  return (
    <div className="flex flex-col gap-2.5 mb-3">
      {/* Search + Sort bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px]">
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
              <svg
                width="12"
                height="12"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="1" y1="1" x2="13" y2="13" />
                <line x1="13" y1="1" x2="1" y2="13" />
              </svg>
            </button>
          )}
        </div>

        {onSortingChange && (
          <div className="flex items-center gap-1.5 shrink-0">
            <select
              aria-label="Sort products"
              data-testid="table-sort-preset-select"
              value={activePresetId}
              onChange={handlePresetChange}
              className="bg-surface border border-hairline rounded-sm text-ink font-sans text-xs px-2.5 py-2 focus:border-ink focus:outline-none transition-colors cursor-pointer"
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              {activePresetId === 'custom' && (
                <option value="custom">
                  Custom Sort ({sorting.length} rule
                  {sorting.length !== 1 ? 's' : ''})
                </option>
              )}
            </select>

            {remainingSortableFields.length > 0 && (
              <select
                aria-label="Add secondary sort column"
                data-testid="table-add-sort-select"
                value=""
                onChange={handleAddSortField}
                title="Add another sort column (or Shift+Click any table header)"
                className="bg-surface-card border border-hairline-soft rounded-sm text-ink-muted hover:text-ink font-sans text-xs px-2 py-2 focus:border-ink focus:outline-none transition-colors cursor-pointer"
              >
                <option value="">
                  {sorting.length === 0 ? '+ Sort Field' : '+ Then By…'}
                </option>
                {remainingSortableFields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.label} ({field.defaultDesc ? 'High→Low' : 'Low→High'})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* Active multi-sort pills */}
      {onSortingChange && sorting.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          data-testid="active-sort-pills"
        >
          <span className="font-sans text-[11px] text-ink-muted mr-0.5">
            Sorted by:
          </span>
          {sorting.map((rule, idx) => (
            <span
              key={rule.id}
              data-testid={`sort-pill-${rule.id}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-surface-card border border-hairline-soft font-sans text-[11px] text-ink"
            >
              <span className="font-mono text-[10px] text-clay font-semibold">
                {idx + 1}.
              </span>
              <span>{getFieldLabel(rule.id)}</span>
              <button
                type="button"
                onClick={() => handleToggleSortDirection(rule.id)}
                aria-label={`Toggle sort direction for ${getFieldLabel(rule.id)}`}
                title="Click to flip Ascending / Descending"
                className="font-mono text-xs text-clay hover:text-clay-active px-0.5 cursor-pointer"
              >
                {rule.desc ? '↓ Desc' : '↑ Asc'}
              </button>
              <button
                type="button"
                onClick={() => handleRemoveSortRule(rule.id)}
                aria-label={`Remove sort on ${getFieldLabel(rule.id)}`}
                title="Remove this sort rule"
                className="text-ink-muted hover:text-crimson ml-0.5 cursor-pointer"
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={handleResetSort}
            data-testid="table-reset-sort"
            className="font-sans text-[11px] text-ink-muted hover:text-ink underline ml-1 cursor-pointer"
          >
            Reset sort
          </button>
        </div>
      )}

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
