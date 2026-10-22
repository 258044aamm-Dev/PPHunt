/**
 * SAD-393 step 7 — A/B parity against the step-0 baseline.
 *
 * `docs/plans/SAD-393-fixtures/baseline-parse.json` was recorded from the
 * PRE-FIX parsers (main @ 2ec7eaf) over the six verbatim captures. This
 * suite replays the same fixtures through today's parsers and diffs every
 * field: the only permitted differences are `badge` and the warranty pair
 * gaining their proven values. Any other field moving — a price, a weight,
 * a title — fails here, which is the contract the issue asks for ("without
 * affecting other fields or existing functionality").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';

const FIXTURES = join(__dirname, '..', 'docs', 'plans', 'SAD-393-fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const baseline = JSON.parse(fixture('baseline-parse.json')) as Record<
  string,
  Record<string, unknown> | Array<Record<string, unknown>>
>;

const SEARCH_URL = 'https://www.amazon.com/s?k=fixture';

/** Every field EXCEPT the ones SAD-393 is allowed to change. */
function stripped(product: Record<string, unknown>): Record<string, unknown> {
  const { badge, warrantyDescription, warrantyDescriptionRaw, ...rest } =
    product as Record<string, unknown> & {
      badge?: unknown;
      warrantyDescription?: unknown;
      warrantyDescriptionRaw?: unknown;
    };
  void badge;
  void warrantyDescription;
  void warrantyDescriptionRaw;
  return rest;
}

function pdpWith(asin: string, body: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>
       <h1 id="productTitle">Fixture ${asin}</h1>
       <input id="ASIN" value="${asin}" />
       ${body}
     </body></html>`,
    'text/html',
  );
}

describe('search fixtures: only `badge` may move', () => {
  it('rio Best Seller + deal card', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="s-main-slot">${fixture('search-card-rio-bestseller-deal.real.html')}</div>`,
      'text/html',
    );
    const products = parseAmazonSearchResults(doc, SEARCH_URL);
    const before = baseline['searchRioBestSellerDeal'] as Array<Record<string, unknown>>;
    expect(products).toHaveLength(before.length);
    expect(stripped(products[0]! as unknown as Record<string, unknown>)).toEqual(stripped(before[0]!));
    expect(products[0]?.badge).toBe('Best Seller');
    expect(before[0]?.['badge']).toBeUndefined();
  });

  it('old-markup Overall Pick card: byte-identical, badge included', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="s-main-slot">${fixture('search-card-overall-pick.real.html')}</div>`,
      'text/html',
    );
    const products = parseAmazonSearchResults(doc, SEARCH_URL);
    const before = baseline['searchOverallPick'] as Array<Record<string, unknown>>;
    expect(products).toHaveLength(before.length);
    expect(products[0]).toEqual(before[0]);
  });
});

describe('PDP fixtures: only the warranty pair may move', () => {
  const cases = [
    {
      key: 'pdpKindle',
      asin: 'B0CFPJYX7P',
      file: 'pdp-kindle-warranty-table.real.html',
      wrapper: 'tech',
      token: '1-year',
      rawContains: '1-year limited warranty and service included',
    },
    {
      key: 'pdpEchoDot',
      asin: 'B09B93ZDG4',
      file: 'pdp-echo-warranty-table.real.html',
      wrapper: 'tech',
      token: '90-day',
      rawContains: '90-day limited warranty and service',
    },
    {
      key: 'pdpDewalt',
      asin: 'B00ET5VMTU',
      file: 'pdp-dewalt-warranty-table.real.html',
      wrapper: 'productDetails_expanderTables_depthRightSections',
      token: '3-year',
      rawContains: '3 Year Limited Warranty',
    },
    {
      key: 'pdpTozo',
      asin: 'B09FT58QQP',
      file: 'pdp-tozo-warranty-table.real.html',
      wrapper: 'productDetails_expanderTables_depthLeftSections',
      token: undefined,
      rawContains: undefined,
    },
  ] as const;

  it.each(cases)('$key ($asin)', ({ key, asin, file, wrapper, token, rawContains }) => {
    const product = parseAmazonProductDetail(
      pdpWith(asin, `<div id="${wrapper}">${fixture(file)}</div>`),
      `https://www.amazon.com/dp/${asin}`,
    );
    const before = baseline[key] as Record<string, unknown>;
    expect(product).not.toBeNull();
    expect(stripped(product! as unknown as Record<string, unknown>)).toEqual(stripped(before));
    expect(product?.warrantyDescription).toBe(token);
    if (rawContains) {
      expect(product?.warrantyDescriptionRaw).toContain(rawContains);
    } else {
      expect(product?.warrantyDescriptionRaw).toBeUndefined();
    }
  });
});

describe('SAD-393 containment: #tech does not widen the weight walk', () => {
  // Measured on the full Echo PDP dump: with #tech in the shared list the
  // weight waterfall began returning "10.7 oz" — true data, but a THIRD
  // field changing, outside this ticket. Weight therefore walks its own
  // pre-SAD-393 container list; this pins that containment.
  it('a Weight row that only exists under #tech is not picked up (warranty still is)', () => {
    const product = parseAmazonProductDetail(
      pdpWith(
        'B0CFPJYX7P',
        `<div id="tech"><table class="a-bordered"><tbody>
           <tr><td style="width:120px;"><p><strong>Weight</strong></p></td>
               <td><p>7.23 oz (205 g) Actual size and weight may vary by configuration and manufacturing process.</p></td></tr>
           <tr><td style="width:120px;"><p><strong>Warranty and Service</strong></p></td>
               <td><p>1-year limited warranty and service included.</p></td></tr>
         </tbody></table></div>`,
      ),
      'https://www.amazon.com/dp/B0CFPJYX7P',
    );
    expect(product?.warrantyDescription).toBe('1-year');
    expect(product?.weight).toBeUndefined();
  });
});
