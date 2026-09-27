#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for scripts/lib/count-ratchet.mjs (#5607): the comparison the
 * jsx-a11y lint ratchet and the viewer smoke's axe scan share.
 *
 * `compareToBaselineRow` is what the axe scan in tests/e2e/axe-baseline.ts
 * decides with, including the missing-file / missing-row case that used to
 * read as an empty allowance (absence-reads-as-success, review on #5638).
 * The e2e itself only runs on CI's viewer lane, so the decision is pinned
 * here where a regression back to `?? {}` fails in the node tests.
 *
 * The module is loaded with a guarded dynamic import, not a static one: the
 * revert oracle reverses this PR's production files, and a static import of
 * a reverted (deleted) module fails to LOAD, which the oracle cannot tell
 * from a broken test. The guard turns that into an ordinary assertion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = join(dirname(fileURLToPath(import.meta.url)), 'count-ratchet.mjs');

async function lib() {
  assert.ok(existsSync(LIB), 'scripts/lib/count-ratchet.mjs does not exist, so neither ratchet has a comparison');
  return import(pathToFileURL(LIB).href);
}

test('compareToBaseline: a count above its row is a regression', async () => {
  const { compareToBaseline } = await lib();
  assert.deepEqual(compareToBaseline({ a: 3 }, { a: 2 }), {
    regressions: [{ key: 'a', count: 3, allowed: 2 }],
    improvements: [],
  });
});

test('compareToBaseline: a key missing from the baseline is allowed zero', async () => {
  const { compareToBaseline } = await lib();
  assert.deepEqual(compareToBaseline({ fresh: 1 }, {}).regressions, [{ key: 'fresh', count: 1, allowed: 0 }]);
});

test('compareToBaseline: a count below its row, or gone entirely, is an improvement', async () => {
  const { compareToBaseline } = await lib();
  assert.deepEqual(compareToBaseline({ a: 1 }, { a: 2, gone: 4 }), {
    regressions: [],
    improvements: [
      { key: 'a', count: 1, allowed: 2 },
      { key: 'gone', count: 0, allowed: 4 },
    ],
  });
});

test('compareToBaselineRow: a missing baseline FILE is missing, not an empty allowance', async () => {
  const { compareToBaselineRow } = await lib();
  // The case the review found: zero violations against no baseline at all
  // compared clean. It must say `missing` whatever the scan measured.
  assert.deepEqual(compareToBaselineRow({}, null, 'empty'), { missing: true });
  assert.deepEqual(compareToBaselineRow({ region: 1 }, null, 'empty'), { missing: true });
});

test('compareToBaselineRow: a missing ROW is missing even when other rows exist', async () => {
  const { compareToBaselineRow } = await lib();
  assert.deepEqual(compareToBaselineRow({}, { empty: { region: 1 } }, 'loaded'), { missing: true });
});

test('compareToBaselineRow: a present row compares like compareToBaseline, both directions', async () => {
  const { compareToBaselineRow } = await lib();
  const baseline = { loaded: { 'aria-allowed-attr': 1, region: 1 } };
  assert.deepEqual(compareToBaselineRow({ 'aria-allowed-attr': 1, region: 1 }, baseline, 'loaded'), {
    missing: false,
    regressions: [],
    improvements: [],
  });
  // One more node of a KNOWN rule is a new violation, not hidden by the rule
  // already being in the baseline (review on #5638).
  assert.deepEqual(compareToBaselineRow({ 'aria-allowed-attr': 2, region: 1 }, baseline, 'loaded').regressions, [
    { key: 'aria-allowed-attr', count: 2, allowed: 1 },
  ]);
  assert.deepEqual(compareToBaselineRow({ region: 1 }, baseline, 'loaded').improvements, [
    { key: 'aria-allowed-attr', count: 0, allowed: 1 },
  ]);
});
