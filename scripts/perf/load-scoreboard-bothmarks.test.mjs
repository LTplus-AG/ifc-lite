/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Both marks side by side: the settled interactive mark and the first frame presented after the
// scene finished, with the share of samples whose next frame comes more than 50 ms after the mark.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

test('the frame mark is the first frame presented at or after finalize end, never before the settled mark; missing times are unknown', async () => {
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
  assert.equal(c.gainFrame, null, 'an unknown sample: no frame gain (the cohorts would differ)');
  const all = bothMarksCell(rows.slice(0, 6));
  assert.ok(all.gainFrame < all.gainCurrent, 'every sample known: the stall makes the branch look worse under the frame mark');
  const md = bothMarksRows([{ name: 'Holter', lanes: { 'browser-cold': { bothMarks: c } } }]);
  assert.match(md[0], /\| Holter \| browser-cold \| .* \| 0\/3 \| .* \| 2\/3 \(\+1 unknown\) \|/);
  assert.deepEqual(bothMarksRows([{ name: 'x', lanes: { 'browser-cold': { bothMarks: bothMarksCell([row('base', 100, null)]) } } }]), [], 'no frame times on either side: no row');
});

test('an early-arm row: frame times move to the first-paint clock with the milestones (review #10043)', async () => {
  const { frameMarkOf } = await load('./load-scoreboard-report-sections.mjs');
  // Change-clock marks 400 / 450 with a 100 ms pick delay become 500 / 550; frames [420, 480, 560] become [520, 580, 660]:
  // the 520 frame (change clock 420) already follows finalize, so no wait. Unshifted, 560 would read as a 10 ms wait.
  assert.deepEqual(frameMarkOf({ geometryMs: 500, interactiveMs: 550, pickDelayMs: 100, presentTimesFromChangeMs: [420, 480, 560] }), { frameMs: 550, waitMs: 0 });
  assert.deepEqual(frameMarkOf({ geometryMs: 500, interactiveMs: 520, pickDelayMs: 100, presentTimesFromChangeMs: [380, 470] }), { frameMs: 570, waitMs: 50 });
});

test('frame gain only over the same cohort; a missing frame mark alone never makes a gain (review #10043)', async () => {
  const { bothMarksCell } = await load('./load-scoreboard-report-sections.mjs');
  const row = (side, i, frames) => ({ side, ok: true, interactiveMs: i, geometryMs: i, presentTimesFromChangeMs: frames });
  const c = bothMarksCell([row('base', 100, [100]), row('base', 200, [200]), row('base', 300, [300]),
    row('branch', 100, [100]), row('branch', 200, [200]), row('branch', 10000, null)]);
  assert.equal(c.gainCurrent, 0);
  assert.equal(c.gainFrame, null);
});

test('fewer than three samples on a side are listed, never summarized, and get no gain (review #10043)', async () => {
  const { bothMarksCell, bothMarksRows } = await load('./load-scoreboard-report-sections.mjs');
  const row = (side, i) => ({ side, ok: true, interactiveMs: i, geometryMs: i, presentTimesFromChangeMs: [i] });
  const c = bothMarksCell([row('base', 100), row('base', 120), row('base', 140), row('branch', 90), row('branch', 95)]);
  assert.equal(c.gainCurrent, null);
  assert.equal(c.gainFrame, null);
  const [md] = bothMarksRows([{ name: 'FZK', lanes: { 'browser-cold': { bothMarks: c } } }]);
  assert.match(md, /\| 120 \| 120 \| 0\/3 \| n=2: 90, 95 \| n=2: 90, 95 \| 0\/2 \| — \| — \| — \| — \|$/);
});

test('the listing rule counts each column: three samples with two known frame marks list the frame values (review #10043)', async () => {
  const { bothMarksCell, bothMarksRows } = await load('./load-scoreboard-report-sections.mjs');
  const row = (side, i, frames) => ({ side, ok: true, interactiveMs: i, geometryMs: i, presentTimesFromChangeMs: frames });
  const c = bothMarksCell([row('base', 100, [100]), row('base', 110, [110]), row('base', 120, null),
    row('branch', 90, [90]), row('branch', 95, [95]), row('branch', 99, [99])]);
  const [md] = bothMarksRows([{ name: 'FZK', lanes: { 'browser-cold': { bothMarks: c } } }]);
  assert.match(md, /^\| FZK \| browser-cold \| 110 \| n=2: 100, 110 \| 0\/2 \(\+1 unknown\) \| 95 \| 95 \| 0\/3 \| \+13\.6% \| — \| — \| — \|$/);
});

test('warm lane hold values are listed when fewer than three are known (review #10210)', async () => {
  const { bothMarksCell, bothMarksRows } = await load('./load-scoreboard-report-sections.mjs');
  const row = (side, frames) => ({ lane: 'browser-warm', side, ok: true, interactiveMs: 400, geometryMs: 300,
    presentTimesFromChangeMs: frames, milestones: { 'load.metadataInteractive': 200 }, completeFrameMs: 300 });
  const c = bothMarksCell([row('base', [250, 350]), row('base', [250, 350]), row('branch', [250, 350]), row('branch', [250, 350])]);
  const [md] = bothMarksRows([{ name: 'FZK', lanes: { 'browser-warm': { bothMarks: c } } }]);
  assert.match(md, /\| n=2: 50, 50 \| n=2: 50, 50 \|$/);
});
