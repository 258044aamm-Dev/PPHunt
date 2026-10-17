export interface AppSettings {
  id: 'default';
  version: number;
  defaultMode: 'manual' | 'automatic';
  defaultTargetCount: number;
  scrollSpeed: number;
  scrollInterval: number;
  waitAfterScroll: number;
  enabledFields: Record<string, boolean>;
  duplicateDetection: boolean;
  notifications: boolean;
  // Stored rows may still hold the legacy 'xlsx' value; ValidatedSettings
// (schema output) normalises it to 'excel' on read (SAD-167).
  exportFormat: 'csv' | 'excel' | 'xlsx' | 'clipboard';
  exportFilename: string;
  includeBOM: boolean;
  /** M-6 (SAD-192) decision D4: image embedding policy for XLSX exports. */
  exportImages: 'auto' | 'always' | 'never';
}