#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: the viewer never calls the browser's native `alert`, `confirm` or
 * `prompt` (#5813).
 *
 * They block the main thread (and the WebGPU frame loop with it), ignore the
 * theme and the locale's button labels, are suppressed outright in some
 * embeds, and cannot be answered from a test. Their replacements are
 * `confirmDialog` / `promptDialog` from `components/ui/confirm-dialog.tsx`
 * and `toast.error` from `components/ui/toast.tsx`. Every call site was
 * migrated, so this is a zero-tolerance check with no baseline.
 *
 * It is a lint and not a test for the reason `check-unbounded-frame-wait.mjs`
 * is: "nobody calls alert()" is an absence claim over the whole source tree,
 * with nothing to drive. The dialogs' behaviour is pinned by
 * `apps/viewer/src/components/ui/confirm-dialog.test.tsx`.
 *
 * Comments and string literals are blanked before matching, so prose that
 * mentions `window.confirm` does not trip it; `.confirm(` on any object other
 * than `window`/`globalThis`/`self` is a method call and is not flagged.
 *
 * Flags (for this script's own test, scripts/check-native-dialogs.test.mjs):
 *   --root <dir>   scan <dir>/apps/viewer/src instead of this repo's
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`check-native-dialogs: ${message}`);
  process.exit(1);
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) yield path;
  }
}

/** `source` with comments and string/template contents replaced by spaces
 *  (newlines kept, so line numbers still line up). */
function blankCommentsAndStrings(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let j = from; j < to; j += 1) if (out[j] !== '\n') out[j] = ' ';
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j;
    }
  }
  return out.join('');
}

/** A bare call, or one through `window`/`globalThis`/`self`; not `x.confirm(`
 *  (a method) and not `function prompt(` (a declaration). */
const NATIVE_CALL = /(?:\b(?:window|globalThis|self)\s*\.\s*|(?<![\w$.]|\.\s+|function\s+))(alert|confirm|prompt)\s*\(/g;

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
if (rootIndex !== -1 && argv[rootIndex + 1] === undefined) fail('--root needs a value');
const root = rootIndex === -1 ? join(dirname(fileURLToPath(import.meta.url)), '..') : resolve(argv[rootIndex + 1]);
const src = join(root, 'apps', 'viewer', 'src');

const hits = [];
let scanned = 0;
try {
  for (const file of sourceFiles(src)) {
    scanned += 1;
    const code = blankCommentsAndStrings(readFileSync(file, 'utf8'));
    for (const match of code.matchAll(NATIVE_CALL)) {
      const line = code.slice(0, match.index).split('\n').length;
      hits.push(`  ${relative(root, file).split('\\').join('/')}:${line}  ${match[1]}()`);
    }
  }
} catch (err) {
  // Fail closed: a moved tree must break this check, not pass having scanned nothing.
  fail(`cannot scan ${src}: ${err.message}`);
}
if (scanned === 0) fail(`no .ts/.tsx files under ${src}; an absence check that scans nothing passes forever.`);

if (hits.length > 0) {
  console.error('check-native-dialogs: native browser dialogs are not allowed in the viewer:\n');
  for (const hit of hits) console.error(hit);
  console.error('\nUse confirmDialog/promptDialog from @/components/ui/confirm-dialog, or toast.error from @/components/ui/toast.');
  process.exit(1);
}
console.log(`check-native-dialogs: OK (${scanned} files scanned, no alert/confirm/prompt calls)`);
