// Build a native Moli --eval-file script; esbuild is already a WXT dependency.
// Usage: node scripts/browser-qa/build-sad389-moli.mjs /absolute/output.js [baseline-evaluate.js]
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const output = resolve(process.argv[2] ?? '.cache/sad389-moli-evaluate.js');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const result = await build({
  entryPoints: ['scripts/browser-qa/sad389-moli.ts'], bundle: true, format: 'iife', platform: 'browser', write: false,
  define: {
    __SAD389_COMMIT__: JSON.stringify(commit),
    __SAD389_COUPON_FIXTURE__: JSON.stringify(readFileSync('tests/fixtures/amazon-sad-389/pdp-coupon.real.html', 'utf8')),
  },
});
const candidate = `(async () => { ${result.outputFiles[0].text}\nreturn await globalThis.__SAD389_FIXED_RESULT; })()`;
let script = candidate;
if (process.argv[3]) {
  // Same-visit, read-only passes. Report whether target DOM stayed stable.
  // The optional baseline is the original read-only Moli reproduction bundle.
  const baseline = readFileSync(resolve(process.argv[3]), 'utf8');
  script = `(async () => {
    const targetNodes = () => [...document.querySelectorAll('.couponLabelText,.s-coupon-unclipped,#social-proofing-faceout-title-tk_bought')].map(el => el.outerHTML);
    const initialTargets = targetNodes();
    const liveLabels = [...document.querySelectorAll('.couponLabelText,.s-coupon-unclipped,#social-proofing-faceout-title-tk_bought')].slice(0,30).map(el => ({text:el.innerText, html:el.outerHTML}));
    const before = await (async (document) => (${baseline}))(document);
    const after = await (async (document) => (${candidate}))(document);
    return {comparison:'Same page visit, sequential read-only baseline/candidate passes; other DOM may hydrate',targetDOMStable:JSON.stringify(initialTargets)===JSON.stringify(targetNodes()),liveLabels,before,after};
  })()`;
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, script);
console.log(JSON.stringify({ output, candidateCommit: commit, bytes: Buffer.byteLength(script), sameVisitBaselineComparison: Boolean(process.argv[3]) }));
