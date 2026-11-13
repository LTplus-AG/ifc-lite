/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Both marks side by side: the current interactive mark (verdicts) and the first frame presented after the
// scene finished, with the share of samples whose next frame comes more than 50 ms after the mark.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

test('the frame mark is the first frame presented at or after finalize end, never before the current mark; missing times are unknown', async () => {
  const { frameMarkOf } = await load('./load-scoreboard-report-sections.mjs');
  // Measured: #9900 Holter cold (pair-9900 branch r0): mark = finalize end 3,492.8; next presented frame 3,660.8.
  assert.deepEqual(frameMarkOf({ geometryMs: 3492.8, interactiveMs: 3492.8, presentTimesFromChangeMs: [3300, 3490, 3660.8, 3700] }), { frameMs: 3660.8, waitMs: 3660.8 - 3492.8 });
  // A settle paint after the finalize already is the frame: no wait.
  assert.deepEqual(frameMarkOf({ geometryMs: 400, interactiveMs: 420, presentTimesFromChangeMs: [405, 430] }), { frameMs: 420, waitMs: 0 });
  assert.equal(frameMarkOf({ geometryMs: 400, interactiveMs: 420, presentTimesFromChangeMs: null }), null, 'no frame times: unknown');
  assert.equal(frameMarkOf({ geometryMs: 400, interactiveMs: 420, presentTimesFromChangeMs: [100, 200] }), null, 'no frame in the window: unknown');
});

test('per side: both medians, the stall share, unknown samples counted apart, gains under both marks', async () => {
  const { bothMarksCell, bothMarksRows } = await load('./load-scoreboard-report-sections.mjs');
  const row = (side, i, next, ok = true) => ({ side, ok, interactiveMs: i, geometryMs: i, presentTimesFromChangeMs: next === null ? null : [i - 50, next] });
  // pair-9900 Holter cold, measured: base waits 0.6 / 11.1 / 9.7 ms; branch 168.0 / 0.6 / 164.5 ms.
  const rows = [row('base', 3542.6, 3543.2), row('base', 3435.4, 3446.5), row('base', 3570.9, 3580.6),
    row('branch', 3492.8, 3660.8), row('branch', 3422.0, 3422.6), row('branch', 3642.7, 3807.2), row('branch', 3500, null)];
  const c = bothMarksCell(rows);
  assert.equal(c.base.stalls, 0);
  assert.equal(c.branch.stalls, 2, 'two of the three known branch samples hit the stall');
  assert.equal(c.branch.known, 3);
  assert.equal(c.branch.unknown, 1, 'a sample without frame times is unknown, not a non-stall');
  assert.ok(c.gainFrame < c.gainCurrent, 'the stall makes the branch look worse under the frame mark');
  const md = bothMarksRows([{ name: 'Holter', lanes: { 'browser-cold': { bothMarks: c } } }]);
  assert.match(md[0], /\| Holter \| browser-cold \| .* \| 0\/3 \| .* \| 2\/3 \(\+1 unknown\) \|/);
  assert.deepEqual(bothMarksRows([{ name: 'x', lanes: { 'browser-cold': { bothMarks: bothMarksCell([row('base', 100, null)]) } } }]), [], 'no frame times on either side: no row');
});
