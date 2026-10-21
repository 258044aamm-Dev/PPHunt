import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  createColumnHelper,
  sortFn_alphanumeric,
  sortFn_basic,
  stockFeatures,
} from '@tanstack/react-table';
import { ExpandableCell } from '@/entrypoints/sidepanel/components/ExpandableCell';
import type { ExpandedCellPayload } from '@/entrypoints/sidepanel/components/CellExpandModal';
import type { ValidatedSettings } from '../../schemas/settings';
import type { AmazonProduct } from '../../types/product';
import { formatCurrency } from '../../utils/formatters';
import { dealBadgeForDisplay } from '../../utils/deal-text';
import {
  formatListingCategoryLabel,
  resolveListingCategory,
  resolveProductPlacements,
} from '../../utils/listing-category';

const columnHelper = createColumnHelper<typeof stockFeatures, AmazonProduct>();

/**
 * Product thumbnail cell with eager rendering inside the virtualized table,
 * no-referrer policy for Amazon CDN compatibility, and graceful error fallback
 * across both Light and Dark themes.
 */
function ProductImageCell({
  url,
  title,
  asin,
}: {
  url: string | null | undefined;
  title?: string | null;
  asin: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const trimmedUrl = typeof url === 'string' ? url.trim() : '';
  const showImage = Boolean(trimmedUrl) && failedUrl !== trimmedUrl;

  if (showImage) {
    return (
      <img
        src={trimmedUrl}
        alt={title ? `${title} thumbnail` : `Product ${asin}`}
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => setFailedUrl(trimmedUrl)}
        className="w-10 h-10 object-contain rounded-sm bg-surface-soft border border-hairline-soft block shrink-0"
        data-testid={`product-image-${asin}`}
      />
    );
  }

  return (
    <div
      className="w-10 h-10 rounded-sm bg-surface-soft border border-hairline-soft flex items-center justify-center shrink-0"
      data-testid={`product-image-placeholder-${asin}`}
      title="No product image available"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-ink-muted"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    </div>
  );
}

const selectColumn = columnHelper.display({
  id: 'select',
  header: ({ table }) => (
    <input
      type="checkbox"
      aria-label="Select all rows"
      checked={table.getIsAllPageRowsSelected()}
      onChange={table.getToggleAllPageRowsSelectedHandler()}
      className="w-3.5 h-3.5 accent-clay cursor-pointer"
    />
  ),
  cell: ({ row }) => (
    <input
      type="checkbox"
      aria-label={`Select product ${row.original.asin}`}
      checked={row.getIsSelected()}
      onChange={row.getToggleSelectedHandler()}
      className="w-3.5 h-3.5 accent-clay cursor-pointer"
    />
  ),
  size: 40,
  minSize: 40,
  maxSize: 40,
  enableSorting: false,
  enableResizing: false,
});

const rowNumberColumn = columnHelper.display({
  id: 'rowNumber',
  header: '#',
  cell: ({ row }) => {
    const displayIndex = row.getDisplayIndex();
    const rowNumber = displayIndex >= 0 ? displayIndex + 1 : row.index + 1;
    return (
      <span
        className="font-mono text-xs tabular-nums text-ink-muted"
        data-testid="table-row-number"
      >
        {rowNumber}
      </span>
    );
  },
  size: 44,
  minSize: 36,
  maxSize: 64,
  enableSorting: false,
  enableResizing: false,
});

const imageUrlColumn = columnHelper.accessor('imageUrl', {
  header: 'Image',
  cell: (info) => (
    <ProductImageCell
      url={info.getValue()}
      title={info.row.original.title}
      asin={info.row.original.asin}
    />
  ),
  size: 56,
  minSize: 48,
  maxSize: 72,
  enableSorting: false,
  enableResizing: false,
});

const titleColumn = columnHelper.accessor('title', {
  header: 'Title',
  cell: (info) => {
    const product = info.row.original;
    const title = info.getValue();
    const url = product.url;
    const category = resolveListingCategory(product);
    const categoryLabel = formatListingCategoryLabel(category);
    const sectionLabel = product.sectionLabel?.trim() || null;
    const showSectionSubtitle =
      Boolean(sectionLabel) &&
      sectionLabel?.toLowerCase() !== categoryLabel.toLowerCase();
    const placements = resolveProductPlacements(product);
    const extraPlacements = placements.length > 1 ? placements.slice(1) : [];

    const badgeStyle =
      category === 'sponsored'
        ? 'bg-golden/15 text-golden border-golden/30'
        : category === 'recommendation'
          ? 'bg-sky/15 text-sky border-sky/30'
          : 'bg-moss/15 text-moss border-moss/30';

    const badgeIcon =
      category === 'sponsored'
        ? '▲'
        : category === 'recommendation'
          ? '★'
          : '●';

    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          <span
            data-testid={`product-category-badge-${product.asin}`}
            title={
              showSectionSubtitle
                ? `${categoryLabel} (${sectionLabel})`
                : categoryLabel
            }
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border font-sans text-[10px] font-medium leading-none whitespace-nowrap ${badgeStyle}`}
          >
            <span aria-hidden="true">{badgeIcon}</span>
            <span>{categoryLabel}</span>
            {showSectionSubtitle && (
              <span className="opacity-85 truncate max-w-[140px]">
                · {sectionLabel}
              </span>
            )}
          </span>
          {extraPlacements.length > 0 && (
            <span
              data-testid={`product-multi-placement-${product.asin}`}
              title={`Appeared in multiple sections: ${placements.join(' + ')}`}
              className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-clay/30 bg-clay/15 text-clay font-sans text-[10px] font-medium leading-none whitespace-nowrap"
            >
              + {extraPlacements.join(', ')}
            </span>
          )}
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-serif text-xs text-ink underline decoration-hairline hover:text-clay hover:decoration-clay line-clamp-2 leading-snug transition-colors"
          title={title ?? undefined}
        >
          {title ?? '—'}
        </a>
      </div>
    );

    if (!title || !meta?.onExpand) return inner;
    return (
      <ExpandableCell
        label="Title"
        columnId="title"
        value={title}
        product={product}
        onExpand={meta.onExpand}
      >
        {inner}
      </ExpandableCell>
    );
  },
  size: 280,
  minSize: 160,
  maxSize: 500,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const asinColumn = columnHelper.accessor('asin', {
  header: 'ASIN',
  cell: (info) => (
    <span className="font-mono text-xs text-ink-muted">{info.getValue()}</span>
  ),
  size: 96,
  minSize: 80,
  maxSize: 120,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const priceColumn = columnHelper.accessor('price', {
  header: 'Price',
  cell: (info) => {
    const price = info.getValue();
    const currency = info.row.original.currency;
    if (price == null) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-mono text-xs text-ink font-medium tabular-nums"
        data-testid={`product-price-${info.row.original.asin}`}
      >
        {formatCurrency(price, currency)}
      </span>
    );
  },
  size: 90,
  minSize: 70,
  maxSize: 120,
  enableSorting: true,
  sortFn: sortFn_basic,
});

const listPriceColumn = columnHelper.accessor('listPrice', {
  header: 'List Price',
  cell: (info) => {
    const listPrice = info.getValue();
    const currency = info.row.original.currency;
    if (listPrice == null) return null;
    return (
      <span
        className="font-mono text-xs text-ink-muted line-through tabular-nums"
        data-testid={`product-list-price-${info.row.original.asin}`}
      >
        {formatCurrency(listPrice, currency)}
      </span>
    );
  },
  size: 96,
  minSize: 76,
  maxSize: 130,
  enableSorting: true,
  sortFn: sortFn_basic,
});

const discountPercentageColumn = columnHelper.accessor('discountPercentage', {
  header: 'Discount',
  cell: (info) => {
    const discount = info.getValue();
    if (!discount) return <span className="text-ink-subtle">No</span>;
    return (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-mono text-xs font-medium bg-clay/15 text-clay whitespace-nowrap"
        data-testid={`product-discount-${info.row.original.asin}`}
      >
        {discount}
      </span>
    );
  },
  size: 88,
  minSize: 72,
  maxSize: 120,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const dealBadgeColumn = columnHelper.accessor('dealBadge', {
  header: 'Deal',
  cell: (info) => {
    // SAD-387: rows saved before the countdown fix still hold the template blob;
    // clean them here rather than rewriting stored rows.
    const deal = dealBadgeForDisplay(info.getValue());
    if (!deal) return <span className="text-ink-subtle">No</span>;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-crimson/15 text-crimson line-clamp-1"
        title={deal}
        data-testid={`product-deal-${info.row.original.asin}`}
      >
        {deal}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Deal" columnId="dealBadge" value={deal} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 136,
  minSize: 100,
  maxSize: 200,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const currencyColumn = columnHelper.accessor('currency', {
  header: 'Curr',
  cell: (info) => {
    const currency = info.getValue();
    if (!currency) return <span className="text-ink-subtle">—</span>;
    return (
      <span className="font-mono text-xs text-ink-muted uppercase">
        {currency}
      </span>
    );
  },
  size: 64,
  minSize: 52,
  maxSize: 84,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const ratingColumn = columnHelper.accessor('rating', {
  header: 'Rating',
  cell: (info) => {
    const rating = info.getValue();
    if (rating == null) return <span className="text-ink-subtle">—</span>;
    const rounded = Math.round(rating);
    return (
      <span className="text-xs whitespace-nowrap">
        <span className="text-golden">{'★'.repeat(rounded)}</span>
        <span className="text-hairline">{'★'.repeat(5 - rounded)}</span>
        <span className="ml-1 font-mono text-xs text-ink-muted">
          {rating.toFixed(1)}
        </span>
      </span>
    );
  },
  size: 100,
  minSize: 80,
  maxSize: 130,
  enableSorting: true,
  sortFn: sortFn_basic,
});

const reviewCountColumn = columnHelper.accessor('reviewCount', {
  header: 'Reviews',
  cell: (info) => {
    const count = info.getValue();
    if (count == null) return <span className="text-ink-subtle">—</span>;
    return (
      <span className="font-mono text-xs tabular-nums text-ink-muted">
        {count.toLocaleString()}
      </span>
    );
  },
  size: 76,
  minSize: 56,
  maxSize: 110,
  enableSorting: true,
  sortFn: sortFn_basic,
});

const bestSellersRankColumn = columnHelper.accessor('bestSellersRank', {
  header: 'Best Sellers Rank',
  cell: (info) => {
    const bsr = info.getValue();
    if (!bsr) return null;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-ink line-clamp-1"
        title={bsr}
        data-testid={`product-bsr-${info.row.original.asin}`}
      >
        {bsr}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Best Sellers Rank" columnId="bestSellersRank" value={bsr} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 160,
  minSize: 120,
  maxSize: 280,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const pastMonthSalesColumn = columnHelper.accessor('pastMonthSales', {
  header: 'Monthly Sales',
  cell: (info) => {
    const sales = info.getValue();
    if (!sales) return null;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-moss font-medium line-clamp-1"
        title={sales}
        data-testid={`product-monthly-sales-${info.row.original.asin}`}
      >
        {sales}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Monthly Sales" columnId="pastMonthSales" value={sales} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 150,
  minSize: 110,
  maxSize: 220,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const couponColumn = columnHelper.accessor('coupon', {
  header: 'Coupon',
  cell: (info) => {
    const coupon = info.getValue();
    if (!coupon) return <span className="text-ink-subtle">No</span>;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-moss/15 text-moss line-clamp-1"
        title={coupon}
        data-testid={`product-coupon-${info.row.original.asin}`}
      >
        {coupon}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Coupon" columnId="coupon" value={coupon} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 140,
  minSize: 100,
  maxSize: 220,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const badgeColumn = columnHelper.accessor('badge', {
  header: 'Badge',
  cell: (info) => {
    const badge = info.getValue();
    if (!badge) return <span className="text-ink-subtle">No</span>;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-golden/15 text-golden line-clamp-1"
        title={badge}
        data-testid={`product-badge-${info.row.original.asin}`}
      >
        {badge}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Badge" columnId="badge" value={badge} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 124,
  minSize: 90,
  maxSize: 180,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const deliveryColumn = columnHelper.accessor('delivery', {
  header: 'Delivery',
  cell: (info) => {
    const delivery = info.getValue();
    if (!delivery) return null;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-ink-muted line-clamp-1"
        title={delivery}
        data-testid={`product-delivery-${info.row.original.asin}`}
      >
        {delivery}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Delivery" columnId="delivery" value={delivery} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 150,
  minSize: 110,
  maxSize: 240,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const brandColumn = columnHelper.accessor('brand', {
  header: 'Brand',
  cell: (info) => {
    const brand = info.getValue();
    if (!brand) return null;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-ink line-clamp-1"
        title={brand}
      >
        {brand}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Brand" columnId="brand" value={brand} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 110,
  minSize: 80,
  maxSize: 200,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const sellerColumn = columnHelper.accessor('seller', {
  header: 'Seller',
  cell: (info) => {
    const seller = info.getValue();
    if (!seller) return null;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-ink-muted line-clamp-1"
        title={seller}
      >
        {seller}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Seller" columnId="seller" value={seller} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 110,
  minSize: 80,
  maxSize: 200,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const availabilityColumn = columnHelper.accessor('availability', {
  header: 'Availability',
  cell: (info) => {
    const availability = info.getValue();
    if (!availability) return null;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-ink-muted line-clamp-1"
        title={availability}
      >
        {availability}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Availability" columnId="availability" value={availability} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 120,
  minSize: 90,
  maxSize: 220,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const isPrimeColumn = columnHelper.accessor('isPrime', {
  header: 'Prime',
  cell: (info) => {
    const isPrime = Boolean(info.getValue());
    return isPrime ? (
      <span className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-sky/15 text-sky">
        Prime
      </span>
    ) : (
      <span className="text-ink-subtle font-sans text-xs">No</span>
    );
  },
  size: 68,
  minSize: 56,
  maxSize: 90,
  enableSorting: true,
  sortFn: sortFn_basic,
});

const isSponsoredColumn = columnHelper.accessor('isSponsored', {
  header: 'Sponsored',
  cell: (info) => {
    const isSponsored = Boolean(info.getValue());
    return isSponsored ? (
      <span className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-golden/15 text-golden">
        Yes
      </span>
    ) : (
      <span className="text-ink-subtle font-sans text-xs">No</span>
    );
  },
  size: 84,
  minSize: 68,
  maxSize: 110,
  enableSorting: true,
  sortFn: sortFn_basic,
});

const urlColumn = columnHelper.accessor('url', {
  header: 'URL',
  cell: (info) => {
    const url = info.getValue();
    if (!url) return <span className="text-ink-subtle">—</span>;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-ink-muted underline decoration-hairline hover:text-clay line-clamp-1"
        title={url}
      >
        /dp/{info.row.original.asin}
      </a>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="URL" columnId="url" value={url} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 110,
  minSize: 80,
  maxSize: 200,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const descriptionColumn = columnHelper.accessor('description', {
  header: 'Description',
  cell: (info) => {
    const desc = info.getValue();
    if (!desc) return null;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-serif text-xs text-ink-muted line-clamp-2"
        title={desc}
      >
        {desc}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Description" columnId="description" value={desc} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 200,
  minSize: 120,
  maxSize: 400,
  enableSorting: false,
});

const featuresColumn = columnHelper.accessor('features', {
  header: 'Features',
  cell: (info) => {
    const features = info.getValue();
    if (!features || features.length === 0) {
      return null;
    }
    const joined = features.join(' • ');
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-serif text-xs text-ink-muted line-clamp-2"
        title={joined}
      >
        {joined}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Features" columnId="features" value={features} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 200,
  minSize: 120,
  maxSize: 400,
  enableSorting: false,
});

const variationsColumn = columnHelper.accessor('variations', {
  header: 'Variations',
  cell: (info) => {
    const variations = info.getValue();
    if (!variations) return null;
    const meta = info.table.options.meta as
      | { onExpand?: (p: ExpandedCellPayload) => void }
      | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-ink line-clamp-1"
        title={variations}
        data-testid={`product-variations-${info.row.original.asin}`}
      >
        {variations}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell
        label="Variations"
        columnId="variations"
        value={variations}
        product={info.row.original}
        onExpand={meta.onExpand}
      >
        {inner}
      </ExpandableCell>
    );
  },
  size: 180,
  minSize: 120,
  maxSize: 320,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const weightColumn = columnHelper.accessor('weight', {
  header: 'Weight',
  cell: (info) => {
    const weight = info.getValue();
    if (!weight) return null;
    return (
      <span
        className="font-mono text-xs text-ink whitespace-nowrap tabular-nums"
        title={weight}
        data-testid={`product-weight-${info.row.original.asin}`}
      >
        {weight}
      </span>
    );
  },
  size: 96,
  minSize: 76,
  maxSize: 150,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

/**
 * SAD-349: the normalized warranty token, with the verbatim cell it was derived
 * from as the tooltip — the same pattern every other truncated cell here uses,
 * so the full text is readable without widening the column for it.
 *
 * Renders `No` when absent, matching Discount/Deal/Coupon/Badge rather than the
 * blank used by purely descriptive fields: "this product states no warranty" is
 * a finding, not missing data.
 */
const warrantyDescriptionColumn = columnHelper.accessor('warrantyDescription', {
  header: 'Warranty',
  cell: (info) => {
    const warranty = info.getValue();
    if (!warranty) return <span className="text-ink-subtle">No</span>;
    const raw = info.row.original.warrantyDescriptionRaw;
    const meta = info.table.options.meta as { onExpand?: (p: ExpandedCellPayload) => void } | undefined;
    const inner = (
      <span
        className="font-mono text-xs text-ink whitespace-nowrap"
        title={raw ?? warranty}
        data-testid={`product-warranty-${info.row.original.asin}`}
      >
        {warranty}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell label="Warranty" columnId="warrantyDescription" value={warranty} raw={raw ?? null} product={info.row.original} onExpand={meta.onExpand}>
        {inner}
      </ExpandableCell>
    );
  },
  size: 110,
  minSize: 90,
  maxSize: 160,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const sourceColumn = columnHelper.accessor('source', {
  header: 'Source',
  cell: (info) => {
    const source = info.getValue();
    const colors: Record<string, string> = {
      search: 'bg-sky/15 text-sky',
      detail: 'bg-moss/15 text-moss',
      category: 'bg-golden/15 text-golden',
    };
    return (
      <span
        className={`inline-block px-2 py-0.5 rounded-sm font-sans text-xs font-medium ${
          colors[source] ?? 'bg-surface-soft text-ink-muted'
        }`}
      >
        {source}
      </span>
    );
  },
  size: 76,
  minSize: 64,
  maxSize: 96,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

export const amazonColumns: Array<
  ColumnDef<typeof stockFeatures, AmazonProduct, any>
> = [
  selectColumn,
  rowNumberColumn,
  imageUrlColumn,
  titleColumn,
  asinColumn,
  priceColumn,
  listPriceColumn,
  discountPercentageColumn,
  dealBadgeColumn,
  currencyColumn,
  ratingColumn,
  reviewCountColumn,
  bestSellersRankColumn,
  pastMonthSalesColumn,
  couponColumn,
  badgeColumn,
  deliveryColumn,
  brandColumn,
  sellerColumn,
  availabilityColumn,
  isPrimeColumn,
  isSponsoredColumn,
  urlColumn,
  // SAD-333: default-on, matching DEFAULT_ENABLED_FIELDS, so the static
  // (settings-not-loaded) column set and the defaults can never diverge.
  descriptionColumn,
  featuresColumn,
  // SAD-357: default-on, matching DEFAULT_ENABLED_FIELDS.
  variationsColumn,
  weightColumn,
  // SAD-349: PDP-only like the two above, and default-on for the same reason.
  warrantyDescriptionColumn,
  sourceColumn,
];

export { amazonColumns as columns };

export function getAmazonColumnsForSettings(
  enabledFields?: ValidatedSettings['enabledFields'],
) {
  if (!enabledFields) return amazonColumns;

  const active: Array<ColumnDef<typeof stockFeatures, AmazonProduct, any>> = [
    selectColumn,
    rowNumberColumn,
  ];
  if (enabledFields.imageUrl !== false) active.push(imageUrlColumn);
  if (enabledFields.title !== false) active.push(titleColumn);
  if (enabledFields.asin !== false) active.push(asinColumn);
  if (enabledFields.price !== false) active.push(priceColumn);
  if (enabledFields.listPrice !== false) active.push(listPriceColumn);
  if (enabledFields.discountPercentage !== false) {
    active.push(discountPercentageColumn);
  }
  if (enabledFields.dealBadge !== false) active.push(dealBadgeColumn);
  if (enabledFields.currency !== false) active.push(currencyColumn);
  if (enabledFields.rating !== false) active.push(ratingColumn);
  if (enabledFields.reviewCount !== false) active.push(reviewCountColumn);
  if (enabledFields.bestSellersRank !== false) {
    active.push(bestSellersRankColumn);
  }
  if (enabledFields.pastMonthSales !== false) {
    active.push(pastMonthSalesColumn);
  }
  if (enabledFields.coupon !== false) active.push(couponColumn);
  if (enabledFields.badge !== false) active.push(badgeColumn);
  if (enabledFields.delivery !== false) active.push(deliveryColumn);
  if (enabledFields.brand !== false) active.push(brandColumn);
  if (enabledFields.seller !== false) active.push(sellerColumn);
  if (enabledFields.availability !== false) active.push(availabilityColumn);
  if (enabledFields.isPrime !== false) active.push(isPrimeColumn);
  if (enabledFields.isSponsored !== false) active.push(isSponsoredColumn);
  if (enabledFields.url !== false) active.push(urlColumn);
  if (enabledFields.description) active.push(descriptionColumn);
  if (enabledFields.features) active.push(featuresColumn);
  if (enabledFields.variations) active.push(variationsColumn);
  if (enabledFields.weight) active.push(weightColumn);
  // SAD-349: truthy check, matching description/features (SAD-333), so a settings
  // row predating the key does not silently drop the column.
  if (enabledFields.warrantyDescription) active.push(warrantyDescriptionColumn);
  active.push(sourceColumn);

  return active;
}

export { getAmazonColumnsForSettings as getColumnsForSettings };
