#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the merge-base audit rules (#4388), against the three
 * conflict resolutions the issue records verbatim plus the boundaries that
 * separate "this change's row" from "somebody else's".
 *
 * Run: node --test scripts/lib/module-size-base-audit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditAgainstBase, compactAudit, summarizeAudit } from './module-size-base-audit.mjs';

const rows = (obj) => new Map(Object.entries(obj));
const measureFrom = (obj) => (rel) => (Object.hasOwn(obj, rel) ? obj[rel] : null);

test('the #4330 resolution fails on all three rows, each for its own reason (#4388)', () => {
  // main deleted project-units.ts's row (the file is 268 lines); the PR
  // split schedule-extractor.ts 594 -> 348 and deleted its row; the
  // resolution resurrected the first, kept the second, and carried a 766 for
  // a 765-line file. Base = main's allowlist; HEAD = the resolution.
  const audit = auditAgainstBase({
    baseRows: rows({ 'packages/parser/src/schedule-extractor.ts': 594, 'packages/parser/src/x.ts': 765 }),
    headRows: rows({
      'packages/parser/src/project-units.ts': 523,
      'packages/parser/src/schedule-extractor.ts': 594,
      'packages/parser/src/x.ts': 766,
    }),
    measure: measureFrom({
      'packages/parser/src/project-units.ts': 268,
      'packages/parser/src/schedule-extractor.ts': 348,
      'packages/parser/src/x.ts': 765,
    }),
    changed: new Set(['packages/parser/src/schedule-extractor.ts', 'packages/parser/src/x.ts']),
  });
  assert.deepEqual(audit.added, ['  packages/parser/src/project-units.ts: added at 523']);
  assert.deepEqual(audit.raised, ['  packages/parser/src/x.ts: raised 765 -> 766']);
  assert.deepEqual(audit.lowered, []);
  assert.deepEqual(audit.deleted, []);
  assert.equal(audit.kept, 1);
  assert.equal(audit.failures.length, 3, audit.failures.join('\n'));
  assert.match(audit.failures[0], /project-units\.ts: row added at 523, but the file measures 268 <= 400 and needs no row/);
  assert.match(audit.failures[1], /schedule-extractor\.ts: this change took the file to 348 <= 400 but kept its row \(budget 594\)/);
  assert.match(audit.failures[2], /x\.ts: row raised 765 -> 766, but the file measures 765: 1 line\(s\) of headroom/);
  assert.equal(summarizeAudit(audit), '+1 added, ^1 raised, v0 lowered, -0 deleted');
  assert.equal(compactAudit(audit), '+1 ^1 v0 -0');
});

test('what --update writes passes: every edited row equals its measurement', () => {
  const audit = auditAgainstBase({
    baseRows: rows({ 'a.ts': 500, 'b.ts': 600, 'c.ts': 450 }),
    headRows: rows({ 'a.ts': 520, 'b.ts': 580, 'd.ts': 401 }),
    measure: measureFrom({ 'a.ts': 520, 'b.ts': 580, 'c.ts': 300, 'd.ts': 401 }),
    changed: new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']),
  });
  assert.deepEqual(audit.failures, []);
  assert.equal(summarizeAudit(audit), '+1 added, ^1 raised, v1 lowered, -1 deleted');
});

test('a kept row is advisory when the shrink landed elsewhere, a failure when it is this change\'s', () => {
  const input = {
    baseRows: rows({ 'a.ts': 500 }),
    headRows: rows({ 'a.ts': 500 }),
    measure: measureFrom({ 'a.ts': 300 }),
  };
  const elsewhere = auditAgainstBase({ ...input, changed: new Set(['unrelated.ts']) });
  assert.deepEqual(elsewhere.failures, []);
  assert.equal(elsewhere.kept, 1);
  const mine = auditAgainstBase({ ...input, changed: new Set(['a.ts']) });
  assert.equal(mine.failures.length, 1);
  assert.match(mine.failures[0], /this change took the file to 300 <= 400 but kept its row/);
});

test('a kept row with slack on a file this change touched stays advisory', () => {
  // main carries 14 rows with headroom today; failing a PR that merely
  // edits one of those files would redden work that never touched the row.
  const audit = auditAgainstBase({
    baseRows: rows({ 'a.ts': 500 }),
    headRows: rows({ 'a.ts': 500 }),
    measure: measureFrom({ 'a.ts': 480 }),
    changed: new Set(['a.ts']),
  });
  assert.deepEqual(audit.failures, []);
});

test('a kept row for a file this change removed fails; removed elsewhere, it does not', () => {
  const input = { baseRows: rows({ 'a.ts': 500 }), headRows: rows({ 'a.ts': 500 }), measure: () => null };
  assert.deepEqual(auditAgainstBase({ ...input, changed: new Set() }).failures, []);
  const mine = auditAgainstBase({ ...input, changed: new Set(['a.ts']) });
  assert.match(mine.failures[0], /removed or renamed the file but kept its row \(budget 500\)/);
});

test('an edited row for a module that was not measured fails', () => {
  const audit = auditAgainstBase({
    baseRows: rows({ 'a.ts': 500 }),
    headRows: rows({ 'a.ts': 500, 'ghost.ts': 450 }),
    measure: measureFrom({ 'a.ts': 500 }),
    changed: new Set(),
  });
  assert.match(audit.failures[0], /ghost\.ts: row added at 450, but no such module was measured/);
});

test('a deleted row whose file is still over the limit names the merge base', () => {
  const audit = auditAgainstBase({
    baseRows: rows({ 'a.ts': 500, 'b.ts': 450 }),
    headRows: rows({ 'a.ts': 500 }),
    measure: measureFrom({ 'a.ts': 500, 'b.ts': 450 }),
    changed: new Set(),
  });
  assert.deepEqual(audit.deleted, ['  b.ts: deleted (was 450)']);
  assert.match(audit.failures[0], /b\.ts: row \(budget 450\) deleted relative to the merge base, but the file measures 450 > 400/);
});

test('growth past an edited budget is left to the grew tooth, not double-reported', () => {
  const audit = auditAgainstBase({
    baseRows: rows({ 'a.ts': 500 }),
    headRows: rows({ 'a.ts': 510 }),
    measure: measureFrom({ 'a.ts': 530 }),
    changed: new Set(['a.ts']),
  });
  assert.deepEqual(audit.failures, []);
  assert.deepEqual(audit.raised, ['  a.ts: raised 500 -> 510']);
});

test('a lowered row must still equal the measurement', () => {
  const audit = auditAgainstBase({
    baseRows: rows({ 'a.ts': 800 }),
    headRows: rows({ 'a.ts': 700 }),
    measure: measureFrom({ 'a.ts': 650 }),
    changed: new Set(['a.ts']),
  });
  assert.match(audit.failures[0], /row lowered 800 -> 700, but the file measures 650: 50 line\(s\) of headroom/);
});

test('an identical allowlist produces zero counts and zero failures', () => {
  const audit = auditAgainstBase({
    baseRows: rows({ 'a.ts': 500 }),
    headRows: rows({ 'a.ts': 500 }),
    measure: measureFrom({ 'a.ts': 500 }),
    changed: new Set(['a.ts']),
  });
  assert.deepEqual(audit.failures, []);
  assert.equal(summarizeAudit(audit), '+0 added, ^0 raised, v0 lowered, -0 deleted');
});
