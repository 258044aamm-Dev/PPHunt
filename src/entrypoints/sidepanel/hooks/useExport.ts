import { useState, useCallback, useRef } from 'react';
import type { Product } from '@/types/product';
import type { ExportFormat, ExportResult } from '@/lib/export/types';
import { exportCSV } from '@/lib/export/csv';
import { exportExcel } from '@/lib/export/excel';
import type { EmbedImagesMode } from '@/lib/export/excel';
import { exportClipboard } from '@/lib/export/clipboard';
import { diagnoseError } from '@/lib/diagnostics/error-diagnosis';

const TOAST_DURATION = 5000;

/**
 * Hook that manages export state and execution.
 *
 * Returns:
 * - `exportData(format, products, columns, filename, includeBOM)` — run an export
 * - `isExporting` — true while an export is in progress
 * - `lastResult` — the result of the last export (success/error + message)
 * - `imageProgress` — live `{ fetched, total }` while XLSX images download
 *   (M-6 / SAD-192: a 20 s image budget must not look like a hang)
 * - `clearResult()` — dismiss the toast
 */
export function useExport() {
  const [isExporting, setIsExporting] = useState(false);
  const [lastResult, setLastResult] = useState<ExportResult | null>(null);
  const [imageProgress, setImageProgress] = useState<{
    fetched: number;
    total: number;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResult = useCallback(() => {
    setLastResult(null);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const exportData = useCallback(
    async (
      format: ExportFormat,
      products: Product[],
      visibleColumns: string[],
      filename: string,
      includeBOM: boolean = true,
      excelOptions?: { embedImages?: EmbedImagesMode }
    ) => {
      // Clear previous toast
      clearResult();

      if (products.length === 0) {
        setLastResult({
          success: false,
          message:
            'No products match the current selection. Clear active filters or collect products first.',
          count: 0,
        });
        return;
      }

      setIsExporting(true);

      try {
        switch (format) {
          case 'csv':
            exportCSV(products, visibleColumns, filename, includeBOM);
            setLastResult({
              success: true,
              message: `${products.length} products saved as ${filename}.csv`,
              count: products.length,
            });
            break;

          case 'excel':
            setImageProgress(null);
            await exportExcel(products, visibleColumns, filename, {
              embedImages: excelOptions?.embedImages,
              onProgress: (fetched, total) => setImageProgress({ fetched, total }),
            });
            setLastResult({
              success: true,
              message: `${products.length} products saved as ${filename}.xlsx`,
              count: products.length,
            });
            break;

          case 'clipboard':
            await exportClipboard(products, visibleColumns);
            setLastResult({
              success: true,
              message: `${products.length} products copied to clipboard.`,
              count: products.length,
            });
            break;

          default: {
            // H-1 (SAD-167): an unknown format must be loud, not a silent
            // no-op. The `never` assignment also gives compile-time
            // exhaustiveness if a fourth format is ever added.
            const exhaustive: never = format;
            throw new Error(`Unsupported export format: ${String(exhaustive)}`);
          }
        }
      } catch (err: any) {
        const rawErr =
          format === 'clipboard'
            ? 'Clipboard access was denied. Check browser permissions.'
            : `Export failed: ${err?.message ?? 'Unknown error'}`;
        const diag = diagnoseError(rawErr, {
          code: format === 'clipboard' ? 'EXPORT_FAILED' : 'STORAGE_ERROR',
          preservedCount: products.length,
        });
        const actionableStep = diag.troubleshootingSteps[0] ?? '';
        const msg = actionableStep
          ? `${diag.summary} ${actionableStep}`
          : diag.summary;
        setLastResult({ success: false, message: msg, count: 0 });
      } finally {
        setIsExporting(false);
        setImageProgress(null);

        // Auto-dismiss toast after 5s
        timerRef.current = setTimeout(() => {
          setLastResult(null);
        }, TOAST_DURATION);
      }
    },
    [clearResult]
  );

  return { exportData, isExporting, lastResult, imageProgress, clearResult };
}
