/**
 * Compatibility barrel for Amazon table column definitions.
 * Row numbering uses O(1) row.getDisplayIndex() + 1 in @/engines/amazon/ui/table/columns.
 */
export {
  columns,
  getColumnsForSettings,
} from '@/engines/amazon/ui/table/columns';
