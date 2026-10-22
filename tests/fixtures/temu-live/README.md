# Live Temu PDP captures (SAD-381 step 4)

This directory is empty on purpose: fixtures may not be invented.

To close the live gate:

1. Open a real Temu product page in a logged-in tab.
2. Paste `scripts/temu-dom-capture.js` into the DevTools console.
3. Save the downloaded `sad381-<goodsId>.json` here.
4. Run `npx vitest run tests/temu-pdp-captures.test.ts`.

Each capture is replayed through the real parser, and the no-fabrication
invariants in that spec are enforced against the capture's own text.

`*.html` full-page saves also work; `TEMU_PDP_CAPTURE_DIR` overrides the path.
