# SAD-389: Amazon monthly sales and coupon fixtures

Captured 2026-10-21 using **Moli 1.1.18** against public, logged-out English Amazon.com pages. Baseline source: `2ec7eaf024687c499a1bc2fcc077bd411509040e`.

| File | Source | Observed value |
|---|---|---|
| `search-sales.real.html` | `https://www.amazon.com/s?k=wireless+earbuds&language=en_US`, ASIN `B0HDB173YV` | `5K+ bought in past month` |
| `search-coupon.real.html` | Same search, ASIN `B0HCZ5ZF7J` | `You pay $29.99 with coupon` |
| `pdp-sales.real.html` | `https://www.amazon.com/dp/B0HDB173YV?language=en_US` | `4K+ bought in past month`, split across two spans |
| `pdp-coupon.real.html` | `https://www.amazon.com/dp/B0HCZ5ZF7J?language=en_US` | `Apply 50% coupon`, plus navigation and two embedded style tags |

Search-card analytics attributes and product-link tracking were removed; semantic selectors, field text, hidden branches and structure were retained. The coupon's embedded styles are intentional: the baseline reader incorrectly saves their CSS as coupon text.

The search/PDP sales values differ because those are different page observations. Tests must not force them to agree or compute an estimated number.

Direct Moli follow-up at 16:40–16:41 UTC independently confirmed the coupon CSS leak, native observer gaps, and a controlled remove/restore cache failure on a clone of a real sales card. The controlled cases in the tests are not claims that Amazon naturally delivered that exact hydration order. Chrome extension UI/service-worker E2E is a separate verification boundary.

`helpers.ts` builds deliberately small **controlled** card/PDP shells. Initial `it.fails` regressions documented verified baseline defects while keeping the test-first checkpoint executable. Implementation commits converted all of them to ordinary passing regressions; none remain.

See [the final implementation/verification record](../../../docs/qa/SAD-389-verification.md) for fresh Moli results, built-extension Chromium checks, full regression results and reproduction commands.
