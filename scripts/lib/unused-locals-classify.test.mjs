#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for classifyTscOutput, the branching check-unused-locals.mjs
 * uses to decide whether a non-zero tsc run is real violations, a genuine
 * compile error, or output its own parsing can't account for.
 *
 * The defect class pinned here (PR #2634 review): the original inline
 * version of this logic only checked for an unrecognised `TS####` diagnostic
 * when the recognised count was exactly zero. A run containing ONE correctly
 * parsed unused-locals diagnostic and ONE diagnostic in a shape the script
 * doesn't recognise skipped that check entirely — the unrecognised one
 * vanished with no trace, undercounted, no failure, no message. That is
 * exactly the "I couldn't parse this output" failure this check exists to
 * catch, just reached via a mixed run instead of a fully-unparseable one.
 *
 * Run: node --test scripts/lib/unused-locals-classify.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTscOutput } from './unused-locals-classify.mjs';

test('a single recognised unused-locals diagnostic counts as a violation', () => {
  const output = "src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'violations', count: 1 });
});

test('a genuine compile error is reported as does-not-compile, not silently zero', () => {
  const output = "src/a.ts(1,1): error TS2304: Cannot find name 'Foo'.\n";
  const result = classifyTscOutput(output);
  assert.equal(result.kind, 'does-not-compile');
});

test('output with no TS-shaped diagnostic at all is no-diagnostics', () => {
  assert.deepEqual(classifyTscOutput('some unrelated failure text\n'), { kind: 'no-diagnostics' });
});

test('a lone unrecognised TS#### diagnostic is unparseable', () => {
  // Not "error TS...:" and not one of the unused-locals codes.
  const output = "src/b.ts(4,3): warning TS6385: 'oldApi' is deprecated.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'unparseable' });
});

// ---- The mixed-output gap from the review.

test('one recognised violation PLUS one unrecognised diagnostic is unparseable, not a silent count of 1', () => {
  const output = "src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n"
    + "src/b.ts(4,3): warning TS6385: 'oldApi' is deprecated.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'unparseable' });
});

test('order does not matter: unrecognised diagnostic first, recognised one second', () => {
  const output = "src/b.ts(4,3): warning TS6385: 'oldApi' is deprecated.\n"
    + "src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'unparseable' });
});

test('two recognised violations plus one unrecognised diagnostic is still unparseable', () => {
  const output = "src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n"
    + "src/a.ts(2,1): error TS6133: 'y' is declared but its value is never read.\n"
    + "src/b.ts(4,3): warning TS6385: 'oldApi' is deprecated.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'unparseable' });
});

test('a recognised violation plus a genuine compile error is does-not-compile, count still reported', () => {
  const output = "src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n"
    + "src/c.ts(9,1): error TS2304: Cannot find name 'Bar'.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'does-not-compile', count: 1 });
});

test('a genuine compile error does NOT mask an unrecognised diagnostic in the same run', () => {
  // The other-error branch used to be evaluated first, so a run mixing a real
  // compile error with a diagnostic the script cannot classify came back as
  // does-not-compile — a count reported as if the output had been fully
  // understood. Any leftover `TS####` must win.
  const output = "src/c.ts(9,1): error TS2304: Cannot find name 'Bar'.\n"
    + "src/b.ts(4,3): warning TS6385: 'oldApi' is deprecated.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'unparseable' });
});

test('multiple recognised violations alone all count', () => {
  const output = "src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n"
    + "src/a.ts(2,1): error TS6192: All imports in import declaration are unused.\n";
  assert.deepEqual(classifyTscOutput(output), { kind: 'violations', count: 2 });
});
