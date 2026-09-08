/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins that the four real, tracked `.ifc` playground samples classify as
 * `production` — never `inert` — despite `.gitattributes` marking them
 * `-diff` (#4164).
 *
 * WHY THIS MATTERS. `git diff --numstat` prints `-`/`-` for a path with no
 * textual diff. That happens for three unrelated reasons, only one of which
 * is a fact about the bytes:
 *
 *   1. a NUL byte in the first 8,000 bytes (genuinely binary content),
 *   2. a `.gitattributes` `-diff`/`binary`/diff-driver entry (a config
 *      decision, irrelevant to content), or
 *   3. `core.bigFileThreshold` (a size cutoff, also configuration).
 *
 * A classifier that read those dashes as "this file is binary" would put
 * these four samples in the inert bucket while ~20 Rust/CLI tests parse them
 * byte for byte as STEP text — the oracle would then report a revert of
 * their content as unobserved-therefore-safe.
 *
 * `classifyPath` (revert-oracle.mjs) does NOT have this hole today: it never
 * calls `git diff` at all. `isInertPath` (revert-oracle-inert.mjs) is a pure
 * extension deny-list, and `.ifc` is not on it. This test pins that outcome
 * against a *future* regression — e.g. someone reintroducing a numstat-based
 * text/binary check, or widening the deny-list to include `.ifc` — rather
 * than fixing a hole that exists on `main` today (it does not; see #4164).
 *
 * Run: node --test scripts/lib/revert-oracle-ifc-gitattributes.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPath } from './revert-oracle.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

// The four tracked `.ifc` playground samples that `.gitattributes` marks
// `-filter -diff -merge text` (apps/viewer/public/samples/**/*.ifc). Listed
// explicitly, not globbed, so a change to which files exist doesn't silently
// shrink coverage.
const REAL_IFC_SAMPLE_PATHS = [
  'apps/viewer/public/samples/building-architecture.ifc',
  'apps/viewer/public/samples/building-architecture-rev-b.ifc',
  'apps/viewer/public/samples/hello-wall.ifc',
  'apps/viewer/public/samples/infra-bridge.ifc',
];

test('the four real .ifc samples still carry the -diff gitattributes entry', () => {
  // `git check-attr` reports an attribute for a path even when that path
  // isn't tracked, and `classifyPath` below only ever sees the path string —
  // neither call notices a deleted or renamed sample. Fail loudly first if
  // any listed path stopped being tracked, so this test can't silently keep
  // passing (against `unspecified`, not `unset`) while coverage for that
  // sample is gone.
  execFileSync(
    'git',
    ['ls-files', '--error-unmatch', '--', ...REAL_IFC_SAMPLE_PATHS],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const output = execFileSync(
    'git',
    ['check-attr', 'diff', '--', ...REAL_IFC_SAMPLE_PATHS],
    { cwd: ROOT, encoding: 'utf8' },
  );
  for (const relPath of REAL_IFC_SAMPLE_PATHS) {
    // `git check-attr` reports `-diff` as `diff: unset`, distinct from
    // `diff: set` (bare `diff`) and `diff: unspecified` (no rule at all). If
    // this ever reads `unspecified`, .gitattributes stopped covering the
    // path and the premise this test exists to pin no longer holds.
    assert.match(
      output,
      new RegExp(`^${relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: diff: unset$`, 'm'),
      `expected ${relPath} to carry a -diff gitattributes entry`,
    );
  }
});

test('a -diff-marked real .ifc sample classifies as production, not inert', () => {
  for (const relPath of REAL_IFC_SAMPLE_PATHS) {
    assert.equal(
      classifyPath(relPath),
      'production',
      `${relPath} carries -diff in .gitattributes but must still classify as ` +
        `production: a diff tool's willingness to show a textual diff is not ` +
        `a fact about whether the file is binary`,
    );
  }
});
