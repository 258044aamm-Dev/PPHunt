import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  createColumnHelper,
  stockFeatures,
  sortFn_alphanumeric,
  sortFn_basic,
} from '@tanstack/react-table';
import { formatCurrency } from '@/lib/utils/formatters';
import type { TemuProduct } from '../../types/product';

const columnHelper = createColumnHelper<typeof stockFeatures, TemuProduct>();

function TemuProductImageCell({
  url,
  title,
  goodsId,
}: {
  url: string | null | undefined;
  title?: string | null;
  goodsId: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const trimmedUrl = typeof url === 'string' ? url.trim() : '';
  const showImage = Boolean(trimmedUrl) && failedUrl !== trimmedUrl;

  if (showImage) {
    return (
      <img
        src={trimmedUrl}
        alt={title ? `${title} thumbnail` : `Product ${goodsId}`}
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => setFailedUrl(trimmedUrl)}
        className="w-10 h-10 object-contain rounded-sm bg-surface-soft border border-hairline-soft block shrink-0"
        data-testid={`product-image-${goodsId}`}
      />
    );
  }

  return (
    <div
      className="w-10 h-10 rounded-sm bg-surface-soft border border-hairline-soft flex items-center justify-center shrink-0"
      data-testid={`product-image-placeholder-${goodsId}`}
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
      aria-label={`Select product ${row.original.goodsId}`}
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
    <TemuProductImageCell
      url={info.getValue()}
      title={info.row.original.title}
      goodsId={info.row.original.goodsId}
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
    const title = info.getValue();
    const url = info.row.original.url;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-serif text-xs text-ink underline decoration-hairline hover:text-clay hover:decoration-clay line-clamp-2 leading-snug transition-colors"
        title={title ?? undefined}
      >
        {title ?? '—'}
      </a>
    );
  },
  size: 280,
  minSize: 160,
  maxSize: 500,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const goodsIdColumn = columnHelper.accessor('asin', {
  header: 'Goods ID',
  cell: (info) => (
    <span className="font-mono text-xs text-ink-muted">{info.getValue()}</span>
  ),
  size: 132,
  minSize: 100,
  maxSize: 170,
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
        data-testid={`product-price-${info.row.original.goodsId}`}
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
    if (listPrice == null) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-mono text-xs text-ink-muted line-through tabular-nums"
        data-testid={`product-list-price-${info.row.original.goodsId}`}
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
    if (!discount) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-mono text-xs font-medium bg-clay/15 text-clay whitespace-nowrap"
        data-testid={`product-discount-${info.row.original.goodsId}`}
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
    const deal = info.getValue();
    if (!deal) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-crimson/15 text-crimson line-clamp-1"
        title={deal}
        data-testid={`product-deal-${info.row.original.goodsId}`}
      >
        {deal}
      </span>
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
  header: 'Category Rank',
  cell: (info) => {
    const bsr = info.getValue();
    if (!bsr) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-sans text-xs text-ink line-clamp-1"
        title={bsr}
        data-testid={`product-bsr-${info.row.original.goodsId}`}
      >
        {bsr}
      </span>
    );
  },
  size: 160,
  minSize: 120,
  maxSize: 280,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const pastMonthSalesColumn = columnHelper.accessor('pastMonthSales', {
  header: 'Sales Volume',
  cell: (info) => {
    const sales = info.getValue();
    if (!sales) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-sans text-xs text-moss font-medium line-clamp-1"
        title={sales}
        data-testid={`product-monthly-sales-${info.row.original.goodsId}`}
      >
        {sales}
      </span>
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
    if (!coupon) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-moss/15 text-moss line-clamp-1"
        title={coupon}
        data-testid={`product-coupon-${info.row.original.goodsId}`}
      >
        {coupon}
      </span>
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
    if (!badge) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-golden/15 text-golden line-clamp-1"
        title={badge}
        data-testid={`product-badge-${info.row.original.goodsId}`}
      >
        {badge}
      </span>
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
    if (!delivery) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-sans text-xs text-ink-muted line-clamp-1"
        title={delivery}
        data-testid={`product-delivery-${info.row.original.goodsId}`}
      >
        {delivery}
      </span>
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
    if (!brand) return <span className="text-ink-subtle">—</span>;
    return (
      <span className="font-sans text-xs text-ink line-clamp-1" title={brand}>
        {brand}
      </span>
    );
  },
  size: 110,
  minSize: 80,
  maxSize: 200,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const sellerColumn = columnHelper.accessor('seller', {
  header: 'Seller / Mall',
  cell: (info) => {
    const seller = info.getValue();
    if (!seller) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-sans text-xs text-ink-muted line-clamp-1"
        title={seller}
      >
        {seller}
      </span>
    );
  },
  size: 130,
  minSize: 90,
  maxSize: 220,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const availabilityColumn = columnHelper.accessor('availability', {
  header: 'Availability',
  cell: (info) => {
    const availability = info.getValue();
    if (!availability) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-sans text-xs text-ink-muted line-clamp-1"
        title={availability}
      >
        {availability}
      </span>
    );
  },
  size: 120,
  minSize: 90,
  maxSize: 220,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const isPrimeColumn = columnHelper.accessor('isPrime', {
  header: 'Local',
  cell: (info) => {
    const isLocal = Boolean(info.getValue());
    return isLocal ? (
      <span className="inline-block px-1.5 py-0.5 rounded-sm font-sans text-xs font-medium bg-sky/15 text-sky">
        Local
      </span>
    ) : (
      <span className="text-ink-subtle font-sans text-xs">No</span>
    );
  },
  size: 72,
  minSize: 56,
  maxSize: 96,
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
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-ink-muted underline decoration-hairline hover:text-clay line-clamp-1"
        title={url}
      >
        goods_id={info.row.original.goodsId}
      </a>
    );
  },
  size: 150,
  minSize: 100,
  maxSize: 240,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const descriptionColumn = columnHelper.accessor('description', {
  header: 'Description',
  cell: (info) => {
    const desc = info.getValue();
    if (!desc) return <span className="text-ink-subtle">—</span>;
    return (
      <span
        className="font-serif text-xs text-ink-muted line-clamp-2"
        title={desc}
      >
        {desc}
      </span>
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
      return <span className="text-ink-subtle">—</span>;
    }
    const joined = features.join(' • ');
    return (
      <span
        className="font-serif text-xs text-ink-muted line-clamp-2"
        title={joined}
      >
        {joined}
      </span>
    );
  },
  size: 200,
  minSize: 120,
  maxSize: 400,
  enableSorting: false,
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

export const temuColumns: Array<
  ColumnDef<typeof stockFeatures, TemuProduct, unknown>
> = [
  selectColumn,
  rowNumberColumn,
  imageUrlColumn,
  titleColumn,
  goodsIdColumn,
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
  sourceColumn,
];

export function getTemuColumnsForSettings(defaultExportColumns?: string[]) {
  if (!defaultExportColumns || defaultExportColumns.length === 0) {
    return temuColumns;
  }

  const enabled = new Set(defaultExportColumns);
  const active: Array<ColumnDef<typeof stockFeatures, TemuProduct, unknown>> = [
    selectColumn,
    rowNumberColumn,
  ];

  if (enabled.has('imageUrl')) active.push(imageUrlColumn);
  if (enabled.has('title')) active.push(titleColumn);
  if (enabled.has('asin') || enabled.has('goodsId')) active.push(goodsIdColumn);
  if (enabled.has('price')) active.push(priceColumn);
  if (enabled.has('listPrice')) active.push(listPriceColumn);
  if (enabled.has('discountPercentage')) active.push(discountPercentageColumn);
  if (enabled.has('dealBadge')) active.push(dealBadgeColumn);
  if (enabled.has('currency')) active.push(currencyColumn);
  if (enabled.has('rating')) active.push(ratingColumn);
  if (enabled.has('reviewCount')) active.push(reviewCountColumn);
  if (enabled.has('bestSellersRank')) active.push(bestSellersRankColumn);
  if (enabled.has('pastMonthSales')) active.push(pastMonthSalesColumn);
  if (enabled.has('coupon')) active.push(couponColumn);
  if (enabled.has('badge')) active.push(badgeColumn);
  if (enabled.has('delivery')) active.push(deliveryColumn);
  if (enabled.has('brand')) active.push(brandColumn);
  if (enabled.has('seller')) active.push(sellerColumn);
  if (enabled.has('availability')) active.push(availabilityColumn);
  if (enabled.has('isPrime')) active.push(isPrimeColumn);
  if (enabled.has('isSponsored')) active.push(isSponsoredColumn);
  if (enabled.has('url')) active.push(urlColumn);
  if (enabled.has('description')) active.push(descriptionColumn);
  if (enabled.has('features')) active.push(featuresColumn);
  active.push(sourceColumn);

  return active;
}
