/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point the emitted `dist` at the worker files tsc actually produced.
 *
 * BACKGROUND (#4895). `src/worker-parser.ts` builds its module worker with
 * `new URL('./parser.worker.ts', import.meta.url)`, which is what makes a
 * workspace consumer resolve the TypeScript source through Vite. `tsc` copies
 * that literal into `dist/worker-parser.js` unchanged, and the tarball ships
 * only `dist/parser.worker.js` — so `new WorkerParser()` installed from npm
 * asks for a file the package does not contain, and a bundler that resolves
 * `new Worker(new URL(…, import.meta.url))` at build time fails outright
 * rather than at runtime.
 *
 * WHY THIS IS A SCRIPT AND NOT AN INLINE `node -e`. `@ifc-lite/geometry` and
 * `@ifc-lite/pointcloud` carry the same rewrite inline in their build script,
 * each naming the dist files to touch. That list is how the defect came back
 * once already: #633 rewrote `dist/index.js` alone, and #637 had to follow
 * because the worker URL also lived in `dist/geometry-parallel.js`. This
 * script takes no list — it walks every emitted `.js`.
 *
 * WHAT IT REWRITES. Only a `.ts` specifier whose sibling `.js` is a regular
 * file inside `dist`, i.e. a path the tarball will actually contain. A `.ts`
 * specifier with no such counterpart is left alone and reported, because
 * rewriting it would swap one missing file for another and hide the real
 * problem from `verify-dist-worker-urls.mjs`, which runs next and fails on it.
 *
 * WHAT IT CANNOT SEE. It is lexical. A worker URL assembled at runtime from
 * variables (`new URL('./' + name + '.ts', import.meta.url)`) has no literal
 * to match. No code in this package does that today; the verifier is lexical
 * in exactly the same way, so such a URL would pass both silently.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { classifyTarget, relativeTsUrlSpecifier } from './lib/shipped-target.mjs';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Rewrite the `.ts` worker specifiers in one emitted file.
 *
 * Pure so `test/worker-url-specifiers-4895.test.ts` can exercise it without a
 * build: `emitsSibling(jsSpecifier)` answers whether the `.js` counterpart is
 * a shipped file, and is the only thing that touches the filesystem in a real
 * run.
 *
 * @param {string} text file contents
 * @param {(jsSpecifier: string) => boolean} emitsSibling
 * @returns {{ text: string, rewritten: string[], left: string[] }}
 */
export function rewriteWorkerUrls(text, emitsSibling) {
  const rewritten = [];
  const left = [];
  const out = text.replace(relativeTsUrlSpecifier(), (match, quote, specifier) => {
    const asJs = specifier.replace(/\.ts$/, '.js');
    if (!emitsSibling(asJs)) {
      left.push(specifier);
      return match;
    }
    rewritten.push(`${specifier} -> ${asJs}`);
    return `new URL(${quote}${asJs}${quote}, import.meta.url)`;
  });
  return { text: out, rewritten, left };
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
    console.error('rewrite-worker-urls: dist/ does not exist — run tsc first.');
    process.exit(1);
  }

  let scanned = 0;
  const changed = [];
  const left = [];

  for (const file of emittedJsFiles(DIST)) {
    scanned += 1;
    const before = readFileSync(file, 'utf8');
    const result = rewriteWorkerUrls(
      before,
      (asJs) =>
        classifyTarget({ distRoot: DIST, fileDir: dirname(file), specifier: asJs, inspect }) ===
        'shipped',
    );
    left.push(...result.left);
    if (result.text !== before) {
      writeFileSync(file, result.text);
      changed.push(`${file.slice(DIST.length + 1)}: ${result.rewritten.join(', ')}`);
    }
  }

  // Report the bound, not just the work: a run that rewrote nothing and a run
  // that found nothing to rewrite look identical in a build log otherwise.
  console.log(
    `rewrite-worker-urls: scanned ${scanned} emitted file(s), rewrote ${changed.length}.`,
  );
  for (const line of changed) console.log(`  ${line}`);
  for (const specifier of left) {
    console.warn(
      `  left alone: ${specifier} — no shipped sibling. verify-dist-worker-urls will fail on it.`,
    );
  }
}

// See the note in verify-dist-worker-urls.mjs: the hand-rolled entry check
// this file shipped with fell through silently on a symlinked path.
if (isMainEntry(import.meta.url)) {
  main();
}
