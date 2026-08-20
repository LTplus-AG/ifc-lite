#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: `packages/sdk/vitest.setup.ts` must warm exactly the `@ifc-lite/*`
 * packages that `packages/sdk/src/namespaces/*.ts` load with a dynamic
 * `import()`.
 *
 * Every namespace resolves its implementation lazily (`loadIds`, `loadLists`,
 * `loadBcf`, `loadDrawing`, `loadSandbox`) so consumers who never touch
 * `bim.ids` do not pay for it. In tests that means whichever test runs first
 * pays the cold import inside its own 5000ms budget: measured 2002ms for
 * `@ifc-lite/lists` plus `@ifc-lite/data`, which crosses the limit under CI
 * load. It took `main` red on 19 of 20 runs (#2935) after being fixed one file
 * at a time three times before that (3a00b5e64, #2248).
 *
 * The setup file's list is maintained BY HAND against the source. A seventh
 * dynamic import added later would simply not be warmed, and the failure would
 * surface months on as a flake in whichever unrelated test happened to run
 * first. An un-warmed package is indistinguishable from a warmed one until
 * that happens, which is why this is checked rather than trusted.
 *
 * THIS is a lint, not a test. It began as
 * `packages/sdk/src/namespaces/lazy-imports.test.ts` until the repo's own
 * `check-source-text-assertions` gate caught it there, exactly as
 * `check-clash-degenerate-reason-parity.mjs` was caught before it. The gate is
 * right: a claim that one file's list matches another file's declarations can
 * only be made by reading both SOURCES, which is the shape banned in test
 * files. Naming it a check makes the shape honest.
 *
 * VACUITY GUARD: the source side must come back non-empty. Two empty sets are
 * "equal", so if the loader idiom is ever refactored away, this would silently
 * become a check that passes by finding nothing.
 *
 * COMMENTS ARE STRIPPED FIRST on both sides, symmetrically: a package named
 * only in prose -- and both files discuss these packages at length -- must not
 * stand in for a real one, in either direction.
 *
 * Run via `node scripts/check-sdk-lazy-import-warmup.mjs` (CI node-test job).
 * `--root <dir>` points it at a mutated copy of the tree; that is how
 * `check-sdk-lazy-import-warmup.test.mjs` proves it fires.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

const NAMESPACES_REL = 'packages/sdk/src/namespaces';
const SETUP_REL = 'packages/sdk/vitest.setup.ts';

/** Drop `/* … *\/` blocks and `//`-led lines so prose cannot supply a name. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Every `@ifc-lite/*` specifier a namespace loads via a dynamic `import()`.
 *
 * The loader idiom binds the specifier to a `const` and hands it to `import()`,
 * which keeps this robust to how the call itself is formatted. A file with no
 * `import(` at all is skipped, so a STATIC `@ifc-lite/*` import -- which costs
 * nothing to warm because it is already resolved -- is not counted.
 */
export function lazilyImportedPackages(sourcesByFile) {
  const found = new Set();
  for (const source of Object.values(sourcesByFile)) {
    const code = stripComments(source);
    if (!code.includes('import(')) continue;
    for (const m of code.matchAll(/const\s+\w*[Nn]ame\s*=\s*'(@ifc-lite\/[^']+)'/g)) {
      found.add(m[1]);
    }
  }
  return found;
}

/** Every package named in the setup file's `LAZY_NAMESPACE_PACKAGES` array. */
export function warmedPackages(setupSource) {
  const code = stripComments(setupSource);
  const start = code.indexOf('LAZY_NAMESPACE_PACKAGES');
  if (start === -1) return new Set();
  const body = code.slice(start, code.indexOf('];', start));
  return new Set([...body.matchAll(/'(@ifc-lite\/[^']+)'/g)].map((m) => m[1]));
}

function readNamespaceSources(root) {
  const dir = join(root, NAMESPACES_REL);
  const sources = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    sources[entry] = readFileSync(join(dir, entry), 'utf8');
  }
  return sources;
}

const lazy = lazilyImportedPackages(readNamespaceSources(ROOT));
const warmed = warmedPackages(readFileSync(join(ROOT, SETUP_REL), 'utf8'));

const problems = [];

if (lazy.size === 0) {
  problems.push(
    `No dynamic @ifc-lite import found in ${NAMESPACES_REL}.\n` +
      '  Either the lazy-loading idiom changed, or this checker stopped\n' +
      '  recognising it. Both comparisons below would pass against an empty\n' +
      '  set, so this is a failure rather than a clean run.',
  );
}

const missing = [...lazy].filter((name) => !warmed.has(name)).sort();
if (missing.length > 0) {
  problems.push(
    `Imported lazily by ${NAMESPACES_REL} but NOT warmed in ${SETUP_REL}:\n` +
      missing.map((n) => `    ${n}`).join('\n') +
      '\n  The first test to touch one pays its cold import inside a 5000ms\n' +
      '  budget. Add it to LAZY_NAMESPACE_PACKAGES.',
  );
}

const stale = [...warmed].filter((name) => !lazy.has(name)).sort();
if (stale.length > 0) {
  problems.push(
    `Warmed in ${SETUP_REL} but no longer imported lazily by ${NAMESPACES_REL}:\n` +
      stale.map((n) => `    ${n}`).join('\n') +
      '\n  Every test file in the package pays for these for nothing. Remove\n' +
      '  them from LAZY_NAMESPACE_PACKAGES.',
  );
}

if (problems.length > 0) {
  console.error(`\nSDK lazy-import warm-up is out of sync.\n\n  ${problems.join('\n\n  ')}\n`);
  process.exit(1);
}
