import { useCallback, useRef, useState } from 'react';
import { exportClipboard } from '@/lib/export/clipboard';
import { exportCSV } from '@/lib/export/csv';
import { exportExcel, type EmbedImagesMode } from '@/lib/export/excel';
import type { ExportFormat, ExportResult } from '@/lib/export/types';
import { diagnoseError } from '../../diagnostics/error-diagnosis';
import type { AmazonProduct } from '../../types/product';

const TOAST_DURATION = 5000;

export function useAmazonExport() {
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
      products: AmazonProduct[],
      visibleColumns: string[],
      filename: string = 'pphunt-export',
      includeBOM: boolean = true,
      excelOptions?: { embedImages?: EmbedImagesMode },
    ) => {
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
              onProgress: (fetched, total) =>
                setImageProgress({ fetched, total }),
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
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        const rawErr =
          format === 'clipboard'
            ? 'Clipboard access was denied. Check browser permissions.'
            : `Export failed: ${errMsg}`;
        const diagnostic = diagnoseError(rawErr, {
          code: format === 'clipboard' ? 'EXPORT_FAILED' : 'STORAGE_ERROR',
          preservedCount: products.length,
        });
        const actionableStep = diagnostic.troubleshootingSteps[0] ?? '';
        const msg = actionableStep
          ? `${diagnostic.summary} ${actionableStep}`
          : diagnostic.summary;
        setLastResult({ success: false, message: msg, count: 0 });
      } finally {
        setIsExporting(false);
        setImageProgress(null);
        timerRef.current = setTimeout(() => {
          setLastResult(null);
        }, TOAST_DURATION);
      }
    },
    [clearResult],
  );

  return { exportData, isExporting, lastResult, imageProgress, clearResult };
}

export { useAmazonExport as useExport };
