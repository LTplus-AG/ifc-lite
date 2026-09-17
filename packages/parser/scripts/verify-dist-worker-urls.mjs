/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fail the build when an emitted `dist` file points at a worker the package
 * does not ship.
 *
 * BACKGROUND (#4895). This is the half that was missing. `@ifc-lite/geometry`
 * has rewritten its worker URLs since #633, and the defect still shipped again
 * in #637 — the rewrite named the dist files to touch and missed one, and
 * nothing looked at the result. A rewrite that silently does nothing and a
 * rewrite that does its job produce the same green build.
 *
 * So this runs after `rewrite-worker-urls.mjs` and re-derives the answer from
 * the emitted files alone: every `new URL('./x', import.meta.url)` in
 * `dist/**\/*.js` must resolve to a file that exists in `dist`. It does not
 * trust, read or import the rewrite step; if that step is deleted, rewrites
 * the wrong file, or stops matching a future specifier shape, this fails.
 *
 * WHAT "SHIPS" MEANS HERE. `package.json#files` is `["dist", "README.md"]`, so
 * presence in `dist` after the build is presence in the tarball. A future
 * narrower `files` list would make this check too permissive — that is the
 * stated hole, and `pnpm pack` remains the ground truth.
 *
 * WHAT IT CANNOT SEE. Lexical, like the rewrite: a specifier assembled from
 * variables at runtime has no literal to resolve, and passes silently.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Any relative `new URL(…, import.meta.url)`, not only `.ts` ones. */
const SPECIFIER = /new URL\(\s*(['"])(\.\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Collect the specifiers in one file that do not resolve to an existing file.
 *
 * Pure so `test/verify-dist-worker-urls.test.ts` can exercise it against
 * synthetic content rather than this checkout's own `dist`, which a future
 * build change could otherwise make vacuously green.
 *
 * @param {string} text file contents
 * @param {(specifier: string) => boolean} resolvesToShippedFile
 * @returns {{ checked: string[], missing: string[] }}
 */
export function findUnshippedTargets(text, resolvesToShippedFile) {
  const checked = [];
  const missing = [];
  for (const [, , specifier] of text.matchAll(SPECIFIER)) {
    checked.push(specifier);
    if (!resolvesToShippedFile(specifier)) missing.push(specifier);
  }
  return { checked, missing };
}

function* emittedJsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* emittedJsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

function main() {
  if (!existsSync(DIST)) {
    console.error('verify-dist-worker-urls: dist/ does not exist — run tsc first.');
    process.exit(1);
  }

  let files = 0;
  let specifiers = 0;
  const failures = [];

  for (const file of emittedJsFiles(DIST)) {
    files += 1;
    const relative = file.slice(DIST.length + 1);
    const { checked, missing } = findUnshippedTargets(readFileSync(file, 'utf8'), (specifier) =>
      existsSync(resolve(dirname(file), specifier)),
    );
    specifiers += checked.length;
    for (const specifier of missing) failures.push(`dist/${relative}: ${specifier}`);
  }

  if (failures.length > 0) {
    console.error(
      `verify-dist-worker-urls: ${failures.length} specifier(s) point at a file this package does not ship:`,
    );
    for (const line of failures) console.error(`  ${line}`);
    console.error(
      '\nEach one rejects at runtime for an npm consumer, and breaks `vite build` outright\n' +
      'when the bundler resolves it. See #4895.',
    );
    process.exit(1);
  }

  // Say what was covered: "0 problems" is also what a checker that scanned
  // nothing prints, and that is the failure mode this half exists to prevent.
  console.log(
    `verify-dist-worker-urls: ${specifiers} URL specifier(s) in ${files} emitted file(s) all resolve.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
