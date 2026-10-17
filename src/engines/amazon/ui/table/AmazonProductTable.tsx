import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  flexRender,
  stockFeatures,
  useTable,
  type ColumnFiltersState,
  type ColumnSizingState,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLiveQuery } from 'dexie-react-hooks';
import { useConfirmDialog } from '@/entrypoints/sidepanel/components/ConfirmDialog';
import { TableToolbar } from '@/entrypoints/sidepanel/components/TableToolbar';
import { sortProducts } from '@/lib/sorting/product-sorter';
import { db } from '../../db/database';
import { deleteProducts } from '../../db/products';
import type { AmazonProduct } from '../../types/product';
import { AmazonExportModal } from '../components/ExportModal';
import { useAmazonSettings } from '../hooks/useAmazonSettings';
import { useAmazonUIStore } from '../store/uiStore';
import { getAmazonColumnsForSettings } from './columns';
import { AmazonTableEmptyState } from './TableEmptyState';

const ROW_HEIGHT = 52;
const KEYBOARD_SCROLL_STEP = 120;

export interface AmazonProductTableProps {
  fullHeight?: boolean;
  sessionKey?: string | null;
  initialSorting?: SortingState;
  initialGlobalFilter?: string;
}

/**
 * Virtualized Amazon product preview table (TanStack Table v9).
 * Supports curated sort presets, multi-column sorting (Shift+Click or toolbar),
 * and preserves the active sorting order across all export scopes.
 */
export function AmazonProductTable({
  fullHeight = false,
  sessionKey = null,
  initialSorting,
  initialGlobalFilter,
}: AmazonProductTableProps = {}) {
  const setStoreSorting = useAmazonUIStore((s) => s.setPreviewSorting);
  const setStoreGlobalFilter = useAmazonUIStore(
    (s) => s.setPreviewGlobalFilter,
  );

  const [sorting, setSorting] = useState<SortingState>(initialSorting ?? []);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [globalFilter, setGlobalFilter] = useState(initialGlobalFilter ?? '');
  const [exportOpen, setExportOpen] = useState(false);
  const { askConfirm, confirmDialog } = useConfirmDialog();

  useEffect(() => {
    setStoreSorting?.(initialSorting ?? []);
    setStoreGlobalFilter?.(initialGlobalFilter ?? '');
  }, [initialSorting, initialGlobalFilter, setStoreSorting, setStoreGlobalFilter]);

  const handleSortingChange = useCallback(
    (updaterOrValue: Updater<SortingState>) => {
      setSorting((prev) => {
        const next =
          typeof updaterOrValue === 'function'
            ? updaterOrValue(prev)
            : updaterOrValue;
        setStoreSorting?.(next);
        return next;
      });
    },
    [setStoreSorting],
  );

  const handleGlobalFilterChange = useCallback(
    (updaterOrValue: Updater<string>) => {
      setGlobalFilter((prev) => {
        const next =
          typeof updaterOrValue === 'function'
            ? updaterOrValue(prev)
            : updaterOrValue;
        setStoreGlobalFilter?.(next);
        return next;
      });
    },
    [setStoreGlobalFilter],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const { settings } = useAmazonSettings();

  const activeColumns = useMemo(
    () => getAmazonColumnsForSettings(settings?.enabledFields),
    [settings?.enabledFields],
  );

  const products = useLiveQuery(async () => {
    if (sessionKey) {
      const scoped = await db.products
        .where('sessionKey')
        .equals(sessionKey)
        .toArray();
      return scoped.sort((a, b) =>
        (b.collectedAt ?? '').localeCompare(a.collectedAt ?? ''),
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
        (p.delivery ?? '').toLowerCase().includes(lower),
    );
  }, [data, globalFilter]);

  const sortedAllProducts = useMemo(
    () => sortProducts(data, sorting),
    [data, sorting],
  );

  const sortedAndFilteredProducts = useMemo(
    () => sortProducts(filteredProducts, sorting),
    [filteredProducts, sorting],
  );

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
    onSortingChange: handleSortingChange,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    onColumnSizingChange: setColumnSizing,
    onGlobalFilterChange: handleGlobalFilterChange,
    manualSorting: true,
    enableMultiSort: true,
    isMultiSortEvent: (e: unknown) =>
      Boolean((e as { shiftKey?: boolean })?.shiftKey),
    columnResizeMode: 'onChange' as const,
    enableRowSelection: true,
    getRowId: (row: AmazonProduct) => String(row.id ?? row.asin),
  });

  const rows = table.getRowModel().rows;
  const totalTableWidth = table.getCenterTotalSize();

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
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
          container.scrollLeft - KEYBOARD_SCROLL_STEP,
        );
      }
    },
    [],
  );

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const container = parentRef.current;
    if (!container) return;
    if (e.shiftKey && e.deltaY !== 0 && e.deltaX === 0) {
      container.scrollLeft += e.deltaY;
    }
  }, []);

  const selectedIds = useMemo(() => {
    return Object.keys(rowSelection)
      .filter((key) => rowSelection[key])
      .map((key) => parseInt(key, 10))
      .filter((id) => !isNaN(id));
  }, [rowSelection]);

  const handleDeleteSelected = useCallback(async () => {
    if (selectedIds.length === 0) return;
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
    const allIds: Record<string, true> = {};
    sortedAndFilteredProducts.forEach((p) => {
      const rowKey = String(p.id ?? p.asin);
      allIds[rowKey] = true;
    });
    setRowSelection(allIds);
  }, [sortedAndFilteredProducts]);

  const handleDeselectAll = useCallback(() => {
    setRowSelection({});
  }, []);

  const selectedProducts = useMemo(() => {
    return sortedAllProducts.filter(
      (p) => rowSelection[String(p.id ?? p.asin)],
    );
  }, [sortedAllProducts, rowSelection]);

  if (products === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-hairline-soft border-t-clay rounded-full animate-spin" />
      </div>
    );
  }

  if (data.length === 0) {
    return <AmazonTableEmptyState />;
  }

  return (
    <div className="flex flex-col h-full flex-1 min-h-0 min-w-0 w-full">
      <TableToolbar
        totalCount={data.length}
        selectedCount={selectedIds.length}
        globalFilter={globalFilter}
        onGlobalFilterChange={handleGlobalFilterChange}
        onSelectAll={handleSelectAll}
        onDeselectAll={handleDeselectAll}
        onDeleteSelected={handleDeleteSelected}
        onExportOpen={() => setExportOpen(true)}
        sorting={sorting}
        onSortingChange={handleSortingChange}
        engine="amazon"
      />

      <div
        ref={parentRef}
        data-testid="preview-table-scroll-container"
        role="region"
        aria-label="Extracted products preview table"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
        className="preview-table-scroll flex-1 min-h-0 min-w-0 w-full overflow-x-auto overflow-y-auto bg-surface border border-hairline-soft rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-clay"
        style={fullHeight ? undefined : { maxHeight: 'calc(100vh - 220px)' }}
      >
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
                  const sortIndex = header.column.getSortIndex();
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
                          title={
                            header.column.getCanSort()
                              ? 'Click to sort · Shift+Click to add multi-column sort'
                              : undefined
                          }
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {{
                            asc: ' ↑',
                            desc: ' ↓',
                          }[isSorted as string] ?? null}
                          {sorting.length > 1 && sortIndex >= 0 && (
                            <span className="font-mono text-[10px] text-clay">
                              {sortIndex + 1}
                            </span>
                          )}
                        </div>
                      )}
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
                            cell.getContext(),
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}

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

      <AmazonExportModal
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        allProducts={sortedAllProducts}
        selectedProducts={selectedProducts}
        filteredProducts={sortedAndFilteredProducts}
        hasFilter={!!globalFilter}
        hasSelection={selectedIds.length > 0}
      />

      {confirmDialog}
    </div>
  );
}

export { AmazonProductTable as ProductTable };
