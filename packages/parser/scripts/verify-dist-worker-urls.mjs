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
 * the emitted files alone. It does not trust, read or import the rewrite step;
 * if that step is deleted, rewrites the wrong file, or stops matching a future
 * specifier shape, this fails. The two share only `lib/shipped-target.mjs`,
 * which answers what counts as shipped — the same question in both, and two
 * spellings of it is how #637 happened.
 *
 * WHAT COUNTS AS SHIPPED. `package.json#files` is `["dist", "README.md"]`, so
 * a regular file inside `dist` after the build is a file in the tarball —
 * which is why a target outside `dist` and a target that is a directory both
 * fail here even though they exist on disk. See lib/shipped-target.mjs for the
 * three ways the first spelling of this check got that wrong.
 *
 * WHAT IT CANNOT SEE. Lexical, like the rewrite: a specifier assembled from
 * variables at runtime has no literal to resolve, and passes silently.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { classifyTarget, REASONS, relativeUrlSpecifier } from './lib/shipped-target.mjs';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Collect the specifiers in one file that are not shipped, with the reason.
 *
 * Pure so `test/worker-url-specifiers-4895.test.ts` can exercise it against
 * synthetic content rather than this checkout's own `dist`, which a future
 * build change could otherwise make vacuously green.
 *
 * @param {string} text file contents
 * @param {(specifier: string) => 'shipped' | 'outside-dist' | 'not-a-file' | 'missing'} classify
 * @returns {{ checked: string[], problems: { specifier: string, verdict: string }[] }}
 */
export function findUnshippedTargets(text, classify) {
  const checked = [];
  const problems = [];
  for (const [, , specifier] of text.matchAll(relativeUrlSpecifier())) {
    checked.push(specifier);
    const verdict = classify(specifier);
    if (verdict !== 'shipped') problems.push({ specifier, verdict });
  }
  return { checked, problems };
}

function* emittedJsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* emittedJsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

function inspect(absolutePath) {
  try {
    return statSync(absolutePath).isFile() ? 'file' : 'directory';
  } catch {
    return 'missing';
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
    const relativePath = file.slice(DIST.length + 1);
    const { checked, problems } = findUnshippedTargets(readFileSync(file, 'utf8'), (specifier) =>
      classifyTarget({ distRoot: DIST, fileDir: dirname(file), specifier, inspect }),
    );
    specifiers += checked.length;
    for (const { specifier, verdict } of problems) {
      failures.push(`dist/${relativePath}: ${specifier} — ${REASONS[verdict] ?? verdict}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `verify-dist-worker-urls: ${failures.length} specifier(s) point at something this package does not ship:`,
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

// `isMainEntry` rather than comparing `import.meta.url` to `argv[1]` by hand:
// the hand-rolled spelling this file shipped with fell through silently on a
// symlinked path and exited 0 having checked nothing, which is the exact
// failure that helper's header documents.
if (isMainEntry(import.meta.url)) {
  main();
}
