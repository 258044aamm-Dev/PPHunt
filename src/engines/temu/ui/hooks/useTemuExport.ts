import { useCallback, useRef, useState } from 'react';
import type { EmbedImagesMode } from '@/lib/export/excel';
import { diagnoseTemuError } from '../../diagnostics/error-diagnosis';
import { exportTemuClipboard } from '../../export/clipboard';
import { exportTemuCSV } from '../../export/csv';
import { exportTemuExcel } from '../../export/excel';
import {
  buildTemuExportFilename,
  type TemuExportFormatType,
  type TemuExportResult,
} from '../../export/types';
import type { TemuProduct } from '../../types/product';

const TOAST_DURATION = 5000;

export function useTemuExport() {
  const [isExporting, setIsExporting] = useState(false);
  const [lastResult, setLastResult] = useState<TemuExportResult | null>(null);
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
      format: TemuExportFormatType,
      products: TemuProduct[],
      visibleColumns: string[],
      filename: string = buildTemuExportFilename(products.length),
      includeBOM: boolean = true,
      excelOptions?: { embedImages?: EmbedImagesMode }
    ) => {
      clearResult();

      if (products.length === 0) {
        setLastResult({
          success: false,
          message:
            'No Temu products match the current selection. Clear active filters or collect products first.',
          count: 0,
        });
        return;
      }

      setIsExporting(true);

      try {
        switch (format) {
          case 'csv':
            exportTemuCSV(products, visibleColumns, filename, includeBOM);
            setLastResult({
              success: true,
              message: `${products.length} Temu products saved as ${filename}.csv`,
              count: products.length,
            });
            break;

          case 'excel':
          case 'xlsx':
            setImageProgress(null);
            await exportTemuExcel(products, visibleColumns, filename, {
              embedImages: excelOptions?.embedImages,
              onProgress: (fetched, total) =>
                setImageProgress({ fetched, total }),
            });
            setLastResult({
              success: true,
              message: `${products.length} Temu products saved as ${filename}.xlsx`,
              count: products.length,
            });
            break;

          case 'clipboard':
            await exportTemuClipboard(products, visibleColumns);
            setLastResult({
              success: true,
              message: `${products.length} Temu products copied to clipboard.`,
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
        const { diagnostic } = diagnoseTemuError(rawErr, {
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
    [clearResult]
  );

  return { exportData, isExporting, lastResult, imageProgress, clearResult };
}
