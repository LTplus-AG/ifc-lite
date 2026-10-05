#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fail when a tracked script decides "am I the entry point?" by hand-comparing
 * `process.argv[1]` with its own location instead of calling
 * `isMainEntry(import.meta.url)` from scripts/lib/is-main-entry.mjs.
 *
 * The hand-rolled comparison is false under a symlinked path (macOS temp dirs,
 * a symlinked checkout) or a path with a space, and then the script silently
 * does nothing and exits 0. See scripts/lib/main-entry-guards.mjs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findHandRolledMainGuards } from './lib/main-entry-guards.mjs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean);
const hits = findHandRolledMainGuards(files, (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch (err) {
    // A tracked path deleted in the working tree (mid-rebase) has no content.
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
});
if (hits.length > 0) {
  console.error('check-main-entry-guards: hand-rolled entry-point guards (silently skip main under a symlinked or spaced path):');
  for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.text}`);
  console.error("Use `isMainEntry(import.meta.url)` from scripts/lib/is-main-entry.mjs.");
  process.exitCode = 1;
} else {
  console.log(`check-main-entry-guards: ok (${files.length} tracked files)`);
}
