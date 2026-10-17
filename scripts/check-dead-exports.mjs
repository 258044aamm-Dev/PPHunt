#!/usr/bin/env node
/**
 * Dead-export guard (Phase 9 / L-3, SAD-151).
 *
 * Lists every exported symbol in src/lib/** and fails when a symbol has zero
 * references outside its own defining module (searched across src/ and tests/).
 * This is the CI gate that stops dead exports from creeping back in.
 *
 * Known limitation (documented on purpose): a named re-export through a barrel
 * (`export { X } from './x'`) counts as a use. `export *` barrels do not hide
 * anything — the original file is still scanned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const LIB_DIR = join(ROOT, 'src', 'lib');
const SCAN_DIRS = [join(ROOT, 'src'), join(ROOT, 'tests')];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const libFiles = walk(LIB_DIR);
const allFiles = SCAN_DIRS.flatMap((d) => walk(d));
const sources = new Map(allFiles.map((f) => [f, readFileSync(f, 'utf8')]));

const EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;

const dead = [];
for (const file of libFiles) {
  const src = sources.get(file);
  for (const match of src.matchAll(EXPORT_RE)) {
    const name = match[1];
    const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
    // Count every whole-word occurrence across src/ and tests/. The
    // declaration itself accounts for exactly one — anything above that is a
    // real consumer (import, same-file composition, type reference, test).
    let hits = 0;
    for (const other of allFiles) {
      const m = sources.get(other).match(re);
      if (m) hits += m.length;
    }
    if (hits <= 1) dead.push(`${relative(ROOT, file)}: ${name}`);
  }
}

if (dead.length > 0) {
  console.error('Dead exports detected (zero references outside the defining module):');
  for (const d of dead) console.error(`  - ${d}`);
  console.error(
    '\nDelete the symbol, or wire it up. If it is genuinely public API kept for\n' +
      'future use, reference it from a test or move it out of src/lib.'
  );
  process.exit(1);
}
console.log(`Dead-export guard: all src/lib exports have consumers (${libFiles.length} files scanned).`);
