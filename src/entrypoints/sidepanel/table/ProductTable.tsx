import { useState, useMemo, useRef, useCallback } from 'react';
import {
  useTable,
  flexRender,
  stockFeatures,
  type SortingState,
  type ColumnFiltersState,
  type RowSelectionState,
  type ColumnSizingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/database';
import type { Product } from '@/types/product';
import { getColumnsForSettings } from './columns';
import { TableToolbar } from '../components/TableToolbar';
import { TableEmptyState } from './TableEmptyState';
import { ExportModal } from '../components/ExportModal';
import { useSettings } from '../hooks/useSettings';
import { deleteProducts } from '@/lib/db/products';
import { useConfirmDialog } from '../components/ConfirmDialog';

const ROW_HEIGHT = 52;
const KEYBOARD_SCROLL_STEP = 120;

/**
 * Virtualized product preview table (TanStack Table v9).
 *
 * Features:
 * - Optional `sessionKey` scoping so History records preview/export only their own products
 * - Dedicated '#' row-number column that remains accurate when rows are added, removed, filtered, or reordered (SAD-139)
 * - Reliable product thumbnail rendering with no-referrer policy and error fallback (SAD-139)
 * - Unified scroll container (`ref={parentRef}`) keeping the horizontal scrollbar pinned and
 *   visible at the bottom of the Preview viewport even in narrow sidebars (SAD-138)
 * - Horizontal scrolling via scrollbar drag/click, trackpad swipe, Shift+Wheel, and Left/Right arrow keys
 * - Row virtualization (@tanstack/react-virtual) for 10k+ rows
 * - Column sorting (click header)
 * - Column resizing (drag header edge)
 * - Row selection (checkboxes + select all)
 * - Search/filter by title, ASIN, brand, seller, availability, or currency
 * - Dynamic columns synchronized with Settings enabledFields
 * - Live updates via Dexie useLiveQuery
 */
export function ProductTable({
  fullHeight = false,
  sessionKey = null,
}: {
  fullHeight?: boolean;
  sessionKey?: string | null;
} = {}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [globalFilter, setGlobalFilter] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  // L-6 (SAD-194): promise-based confirm replaces window.confirm().
  const { askConfirm, confirmDialog } = useConfirmDialog();

  const parentRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();

  const activeColumns = useMemo(
    () => getColumnsForSettings(settings?.enabledFields),
    [settings?.enabledFields]
  );

  // Live products from IndexedDB, optionally scoped to `sessionKey`
  const products = useLiveQuery(async () => {
    if (sessionKey) {
      const scoped = await db.products
        .where('sessionKey')
        .equals(sessionKey)
        .toArray();
      return scoped.sort((a, b) =>
        (b.collectedAt ?? '').localeCompare(a.collectedAt ?? '')
      );
    }
    return db.products.orderBy('collectedAt').reverse().toArray();
  }, [sessionKey]);

  const data = useMemo(() => products ?? [], [products]);

  const filteredProducts = useMemo(() => {
    if (!globalFilter) return data;
    const lower = globalFilter.toLowerCase();
    return data.filter(
      (p) =>
        (p.title ?? '').toLowerCase().includes(lower) ||
        p.asin.toLowerCase().includes(lower) ||
        (p.brand ?? '').toLowerCase().includes(lower) ||
        (p.seller ?? '').toLowerCase().includes(lower) ||
        (p.availability ?? '').toLowerCase().includes(lower) ||
        (p.currency ?? '').toLowerCase().includes(lower) ||
        (p.dealBadge ?? '').toLowerCase().includes(lower) ||
        (p.discountPercentage ?? '').toLowerCase().includes(lower) ||
        (p.bestSellersRank ?? '').toLowerCase().includes(lower) ||
        (p.pastMonthSales ?? '').toLowerCase().includes(lower) ||
        (p.coupon ?? '').toLowerCase().includes(lower) ||
        (p.badge ?? '').toLowerCase().includes(lower) ||
        (p.delivery ?? '').toLowerCase().includes(lower)
    );
  }, [data, globalFilter]);

  const sortedAndFilteredProducts = useMemo(() => {
    if (sorting.length === 0) return filteredProducts;
    const activeSort = sorting[0];
    if (!activeSort) return filteredProducts;
    const colId = activeSort.id as keyof (typeof filteredProducts)[number];
    const dir = activeSort.desc ? -1 : 1;

    return [...filteredProducts].sort((a, b) => {
      const va = a[colId];
      const vb = b[colId];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') {
        return (va - vb) * dir;
      }
      if (typeof va === 'boolean' && typeof vb === 'boolean') {
        return (Number(va) - Number(vb)) * dir;
      }
      return (
        String(va).localeCompare(String(vb), undefined, {
          numeric: true,
          sensitivity: 'base',
        }) * dir
      );
    });
  }, [filteredProducts, sorting]);

  const table = useTable({
    data: sortedAndFilteredProducts,
    columns: activeColumns,
    features: {
      ...stockFeatures,
      rowSelectionFeature: stockFeatures.rowSelectionFeature,
    },
    state: {
      sorting,
      columnFilters,
      rowSelection,
      columnSizing,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    onColumnSizingChange: setColumnSizing,
    onGlobalFilterChange: setGlobalFilter,
    columnResizeMode: 'onChange' as const,
    enableRowSelection: true,
    getRowId: (row: Product) => String(row.id ?? row.asin),
  });

  const rows = table.getRowModel().rows;
  const totalTableWidth = table.getCenterTotalSize();

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  // noUncheckedIndexedAccess: virtualItems[0] may be undefined when the list is
  // empty — resolve it once instead of asserting at each use site.
  const firstVirtualItem = virtualItems[0];

  // Horizontal keyboard scrolling support (ArrowLeft / ArrowRight)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const container = parentRef.current;
      if (!container) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        container.scrollLeft += KEYBOARD_SCROLL_STEP;
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        container.scrollLeft = Math.max(
          0,
          container.scrollLeft - KEYBOARD_SCROLL_STEP
        );
      }
    },
    []
  );

  // Support Shift + vertical wheel for horizontal scrolling across devices
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const container = parentRef.current;
    if (!container) return;
    if (e.shiftKey && e.deltaY !== 0 && e.deltaX === 0) {
      container.scrollLeft += e.deltaY;
    }
  }, []);

  // Selection helpers
  const selectedIds = useMemo(() => {
    return Object.keys(rowSelection)
      .filter((key) => rowSelection[key])
      .map((key) => parseInt(key, 10))
      .filter((id) => !isNaN(id));
  }, [rowSelection]);

  const handleDeleteSelected = useCallback(async () => {
    if (selectedIds.length === 0) return;
    // L-6 (SAD-194): promise-based confirm replaces window.confirm().
    const ok = await askConfirm({
      title: 'Delete selected products?',
      message: `Delete ${selectedIds.length} selected product(s)?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    await deleteProducts(selectedIds);
    setRowSelection({});
  }, [selectedIds, askConfirm]);

  const handleSelectAll = useCallback(() => {
    // v9 types row selection as Record<string, true> — build that exact shape.
    const allIds: Record<string, true> = {};
    filteredProducts.forEach((p) => {
      const rowKey = String(p.id ?? p.asin);
      allIds[rowKey] = true;
    });
    setRowSelection(allIds);
  }, [filteredProducts]);

  const handleDeselectAll = useCallback(() => {
    setRowSelection({});
  }, []);

  // Products for export
  const selectedProducts = useMemo(() => {
    return data.filter(
      (p) => rowSelection[String(p.id ?? p.asin)]
    );
  }, [data, rowSelection]);

  // Loading state
  if (products === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-hairline-soft border-t-clay rounded-full animate-spin" />
      </div>
    );
  }

  // Empty state
  if (data.length === 0) {
    return <TableEmptyState />;
  }

  return (
    <div className="flex flex-col h-full flex-1 min-h-0 min-w-0 w-full">
      {/* Toolbar */}
      <TableToolbar
        totalCount={data.length}
        selectedCount={selectedIds.length}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        onSelectAll={handleSelectAll}
        onDeselectAll={handleDeselectAll}
        onDeleteSelected={handleDeleteSelected}
        onExportOpen={() => setExportOpen(true)}
      />

      {/* Unified vertical + horizontal scroll container (SAD-138) */}
      <div
        ref={parentRef}
        data-testid="preview-table-scroll-container"
        role="region"
        aria-label="Extracted products preview table"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
        className="preview-table-scroll flex-1 min-h-0 min-w-0 w-full overflow-x-auto overflow-y-auto bg-surface border border-hairline-soft rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-clay"
        style={
          fullHeight
            ? undefined
            : { maxHeight: 'calc(100vh - 220px)' }
        }
      >
        {/* Header & virtualized body */}
        <table
          className="border-collapse table-fixed"
          style={{
            width: `${totalTableWidth}px`,
            minWidth: `${totalTableWidth}px`,
          }}
        >
          <thead className="sticky top-0 z-10 bg-surface-card">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                key={headerGroup.id}
                className="border-b border-hairline-soft"
              >
                {headerGroup.headers.map((header) => {
                  const isSorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={`px-2.5 py-2 text-left font-sans text-xs font-semibold uppercase tracking-wider select-none relative ${
                        isSorted ? 'text-ink' : 'text-ink-muted'
                      }`}
                      style={{ width: header.getSize() }}
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          className={
                            header.column.getCanSort()
                              ? 'cursor-pointer hover:text-ink transition-colors flex items-center gap-1'
                              : ''
                          }
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                          {{
                            asc: ' ↑',
                            desc: ' ↓',
                          }[isSorted as string] ?? null}
                        </div>
                      )}
                      {/* Resize handle */}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-clay/30 transition-colors"
                        />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          {/* Virtualized body */}
          <tbody>
            {virtualItems.length === 0 ? (
              <tr>
                <td
                  colSpan={activeColumns.length}
                  className="px-4 py-8 text-center font-serif text-xs text-ink-muted"
                >
                  No products match your filter.
                </td>
              </tr>
            ) : (
              <>
                {/* Spacer before */}
                {firstVirtualItem && firstVirtualItem.index > 0 && (
                  <tr>
                    <td
                      colSpan={activeColumns.length}
                      style={{ height: firstVirtualItem.start }}
                    />
                  </tr>
                )}

                {virtualItems.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) return null;
                  const isSelected = row.getIsSelected();

                  return (
                    <tr
                      key={row.id}
                      data-index={virtualRow.index}
                      className={`
                        border-b border-hairline-soft transition-colors
                        ${isSelected ? 'bg-clay/10' : 'hover:bg-surface-soft/70'}
                      `}
                      style={{ height: ROW_HEIGHT }}
                    >
                      {row.getVisibleCells().map((cell: any) => (
                        <td
                          key={cell.id}
                          className="px-2.5 py-1.5 text-sm"
                          style={{ width: cell.column.getSize() }}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}

                {/* Spacer after */}
                {virtualItems.length > 0 && (
                  <tr>
                    <td
                      colSpan={activeColumns.length}
                      style={{
                        height:
                          totalSize -
                          (virtualItems[virtualItems.length - 1]?.end ?? 0),
                      }}
                    />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Export modal */}
      <ExportModal
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        allProducts={data}
        selectedProducts={selectedProducts}
        filteredProducts={filteredProducts}
        hasFilter={!!globalFilter}
        hasSelection={selectedIds.length > 0}
      />

      {/* L-6 (SAD-194) */}
      {confirmDialog}
    </div>
  );
}
