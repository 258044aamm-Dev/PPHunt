# SAD-338 — measurement spike: PDP enrichment success

**Status: harness delivered, measurement not taken.**

This document records (a) what the code settles without measuring, and (b) the
method and the exact table that still has to be filled on a residential
connection. There are **no invented numbers** in this file. Where a number is
missing it says so.

---

## 1. Why the numbers are missing

The audit that produced SAD-338 ran from a datacenter IP, where every PDP came
back as a ~3.7 KB bot interstitial. That is not a network condition anyone can
control from a CI runner, and it is not the condition the question is about: the
question is *how often does a normal user's connection succeed, and does the
request shape change that* .

So the deliverable of this half of the spike is a reproducible harness rather
than a measurement: `scripts/enrichment-spike.ts`, run through
`npm run spike:enrichment`. It reuses the **production** classifier, so its
`challenge` label means exactly what it means in the extension.

Two confirmed datapoints from this sandbox, both datacenter:

- **Node, `n = 1`, variant A:** `HTTP 500`, 2 340 bytes.
- **A real Chromium 131.0.0.0** (Playwright, no request rewriting) opening
  `https://www.amazon.com/dp/B08N5WRWNW`: `HTTP 404` with a 2 327-byte body that
  matches the challenge phrases. So the block is not an artefact of Node's TLS
  fingerprint or its missing client hints — a real browser with real headers is
  refused too. That rules out an in-sandbox browser as a way to take this
  measurement, and it explains the audit's `404`/`503` sightings.

Both are recorded here only as that: they are evidence about the *block*, not
the measurement the ticket asks for.

---

## 2. What the code settles without measuring

### 2.1 What the current request sends

`src/engines/amazon/background/enrichment-fetch.ts` (the `fetchImpl` call):

| Property | Value |
|---|---|
| method | `GET` |
| `credentials` | `'omit'` — deliberately no cookies |
| `redirect` | `'follow'` |
| headers | `Accept: text/html,application/xhtml+xml` only |
| `Referer` | none |
| User-Agent | none set — the service worker's own UA is used |
| timeout | `PDP_FETCH_TIMEOUT_MS` = 12 000 ms |
| retries | one, and only for timeout or 5xx (`PDP_RETRY_DELAY_MS` = 1 500 ms) |

No `403`/`429`/`captcha`/`asin-mismatch` is ever retried — retrying a block is
what turns one challenge into three.

### 2.2 Is a tab-side fetch permitted? (question 2)

**For the same marketplace: yes, with no manifest change at all.**

- A content script already runs on every matched Amazon page.
- Fetching `https://www.amazon.com/dp/<ASIN>` from a page on `www.amazon.com` is
  **same-origin**, so the page's CORS policy is satisfied by construction. Since
  Chrome 85, a content-script fetch is subject to the page's CORS — and for the
  same origin there is nothing to fail.
- `host_permissions` already lists all 23 marketplaces
  (`AMAZON_HOST_PERMISSIONS`, derived from `AMAZON_MARKETPLACE_DOMAINS` in
  `wxt.config.ts`), so no new permission and therefore **no new install-time
  prompt and no store re-review**.
- Nothing here needs `web_accessible_resources`.

**For a different marketplace from that tab: no.** `enrichment-fetch.ts:7-12`
already explains why enrichment lives in the background: a content script's
cross-origin fetch obeys the *page's* CORS, and `host_permissions` does not
exempt it. A tab on `amazon.de` could not read an `amazon.com` PDP. Those saves
would still need the service-worker path.

**The real cost is not a permission, it is the cookie.** A tab-side fetch that
wanted to look like a page load would need `credentials: 'include'`, which sends
the user's Amazon session. Production deliberately uses `'omit'` today. That is
a product decision, not a technical one, and it should be taken explicitly if
the spike shows it helps.

Secondary cost: the tab must still be on Amazon when the fetch runs. The
immediate save path always satisfies that; a resumed job after a worker restart
might not.

### 2.3 Are the breaker thresholds right? (question 4)

From `enrichment-fetch.ts`:

- `CIRCUIT_CAPTCHA_THRESHOLD = 3` — three consecutive challenges take the host
  out of service;
- `CIRCUIT_RATE_LIMIT_THRESHOLD = 3` inside `CIRCUIT_RATE_LIMIT_WINDOW_MS` =
  60 000 ms does the same for 429s;
- `CIRCUIT_COOLDOWN_MS` = 60 000 ms.

The threshold is only defensible if per-save success is high. At a high success
rate three consecutive challenges is genuinely anomalous. At a low one, a user
saving four products can blacklist the marketplace for a minute, and the fourth
save reports `skipped / circuit-open` through no fault of their own. **This is
the question the measurement answers**, which is why the table below is ordered
by variant and reports absolute counts, not just percentages.

### 2.4 Question 3 — `asin-mismatch`

The harness classifies `HTTP 200`, no challenge phrase, expected ASIN absent as
`asin_mismatch`, and counts it separately. Whether it needs a fallback path is a
question for the numbers; no fallback is proposed here.

---

## 3. Method

```bash
npm ci
npm run spike:enrichment -- --dry-run          # prints the plan, sends nothing
npm run spike:enrichment -- --count 30         # the measurement
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--marketplace` | `amazon.com` | which marketplace to sample |
| `--search` | `https://www.<marketplace>/s?k=usb+c+charger` | one listing page, used to harvest real ASINs **and** as the `Referer` |
| `--asins` | — | comma-separated ASINs, skips harvesting |
| `--count` | `30` | products per variant (SAD-338 asks for ≥ 30) |
| `--delay` | `3000` | ms between requests, plus up to 1 s jitter |
| `--variants` | all three | subset of `current,referer,ua` |
| `--out` | `docs/plans/measurements` | where the JSON + Markdown run files go |
| `--dry-run` | off | print the request plan and exit |

Variants:

- **A `current`** — exactly today's request.
- **B `referer`** — A + `Referer: <the listing page>`.
- **C `ua`** — A + a desktop Chrome User-Agent.

The harness stops a variant after five consecutive challenges rather than
hammering a host that is blocking us, and reports how many products it left
unmeasured.

### Fidelity caveat — read before trusting absolute numbers

The **classifier** is the production one (`looksLikeChallenge` is imported from
`src/engines/amazon/background/enrichment-fetch.ts`), so the labels are
identical. The **transport** is not: the harness runs in Node, which sends
`undici` defaults and no `sec-ch-ua` / `sec-fetch-*` client hints, and is not a
service worker. Variant C exists because that gap is part of what is being
measured. Treat A/B/C as a comparison between request shapes, not as a
prediction of the extension's exact success rate — and if the numbers are close,
the honest conclusion is "inconclusive at this sample size".

---

## 4. Results

**Not measured yet.** Fill this table from the run output and state the
connection type, country, date and browser/OS next to it. Any row that was not
run must say `not run` — never blank.

Metadata to record:

- Connection: residential / mobile / datacenter (be explicit — a datacenter run
  cannot answer this question)
- Country and marketplace
- Date and local time
- Sample size actually reached per variant

| Variant | n | ok | challenge | asin-mismatch | 429 | 4xx | 5xx | timeout | median | p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| A `current` | | | | | | | | | | |
| B `referer` | | | | | | | | | | |
| C `ua` | | | | | | | | | | |

Questions the table has to answer:

1. Does B or C materially beat A?
2. Is `asin_mismatch` common enough to need a fallback?
3. Given the observed success rate, do the breaker thresholds fire on a
   plausible human save sequence?

---

## 5. Recommendation

**Pending measurement.** The three outcomes and what each implies:

- **If A succeeds most of the time** — keep as-is. The 5 s→10 min capture fix
  (SAD-341) and the enrichment-skip on PDPs (SAD-337) already removed the
  user-visible failures that were not about the network.
- **If B and/or C materially beat A** — file a follow-up to add those headers in
  `enrichment-fetch.ts`. It is a two-line change with no permission cost, and it
  needs its own ticket because SAD-338 explicitly ships no behaviour change.
- **If nothing works from the background at all** — file a follow-up to move the
  fetch origin to the tab (`credentials: 'include'`), and take the cookie
  decision in that ticket, with the manifest analysis in §2.2 as the starting
  point.

No production code was changed by this issue.
