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
import { TableToolbar } from '@/entrypoints/sidepanel/components/TableToolbar';
import { useConfirmDialog } from '@/entrypoints/sidepanel/components/ConfirmDialog';
import { temuDb } from '../../db/database';
import { deleteTemuProducts } from '../../db/products';
import type { TemuProduct } from '../../types/product';
import { useTemuSettings } from '../hooks/useTemuSettings';
import { TemuExportModal } from '../components/ExportModal';
import { getTemuColumnsForSettings } from './columns';
import { TemuTableEmptyState } from './TableEmptyState';

const ROW_HEIGHT = 52;
const KEYBOARD_SCROLL_STEP = 120;

/**
 * Virtualized Temu product preview table (TanStack Table v9).
 * Matches ProductTable 100% in layout, styling, keyboard scrolling, row selection, and virtualization.
 */
export function TemuProductTable({
  fullHeight = false,
  sessionId = null,
}: {
  fullHeight?: boolean;
  sessionId?: string | null;
} = {}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [globalFilter, setGlobalFilter] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const { askConfirm, confirmDialog } = useConfirmDialog();

  const parentRef = useRef<HTMLDivElement>(null);
  const { settings } = useTemuSettings();

  const activeColumns = useMemo(
    () => getTemuColumnsForSettings(settings?.defaultExportColumns),
    [settings?.defaultExportColumns]
  );

  const products = useLiveQuery(async () => {
    if (sessionId) {
      const scoped = await temuDb.products
        .where('sessionId')
        .equals(sessionId)
        .toArray();
      return scoped.sort((a, b) =>
        (b.collectedAt ?? '').localeCompare(a.collectedAt ?? '')
      );
    }
    return temuDb.products.orderBy('collectedAt').reverse().toArray();
  }, [sessionId]);

  const data = useMemo(() => products ?? [], [products]);

  const filteredProducts = useMemo(() => {
    if (!globalFilter) return data;
    const lower = globalFilter.toLowerCase();
    return data.filter(
      (p) =>
        (p.title ?? '').toLowerCase().includes(lower) ||
        p.goodsId.toLowerCase().includes(lower) ||
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
    getRowId: (row: TemuProduct) => String(row.id ?? row.goodsId),
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
    await deleteTemuProducts(selectedIds);
    setRowSelection({});
  }, [selectedIds, askConfirm]);

  const handleSelectAll = useCallback(() => {
    const allIds: Record<string, true> = {};
    filteredProducts.forEach((p) => {
      const rowKey = String(p.id ?? p.goodsId);
      allIds[rowKey] = true;
    });
    setRowSelection(allIds);
  }, [filteredProducts]);

  const handleDeselectAll = useCallback(() => {
    setRowSelection({});
  }, []);

  const selectedProducts = useMemo(() => {
    return data.filter((p) => rowSelection[String(p.id ?? p.goodsId)]);
  }, [data, rowSelection]);

  if (products === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-hairline-soft border-t-clay rounded-full animate-spin" />
      </div>
    );
  }

  if (data.length === 0) {
    return <TemuTableEmptyState />;
  }

  return (
    <div className="flex flex-col h-full flex-1 min-h-0 min-w-0 w-full">
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

      <div
        ref={parentRef}
        data-testid="preview-table-scroll-container"
        role="region"
        aria-label="Extracted Temu products preview table"
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
                      {row.getVisibleCells().map((cell) => (
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

      <TemuExportModal
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        allProducts={data}
        selectedProducts={selectedProducts}
        filteredProducts={filteredProducts}
        hasFilter={!!globalFilter}
        hasSelection={selectedIds.length > 0}
      />

      {confirmDialog}
    </div>
  );
}
