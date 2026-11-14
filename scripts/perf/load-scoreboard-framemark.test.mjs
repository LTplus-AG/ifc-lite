/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Verdict mark = frame mark for browser lanes (user decision 2026-11-13): the settled mark stays a column with its own
// verdict row; a browser sample without frame times leaves the frame-mark cell unverifiable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

const plan = (kind = 'compare') => ({ name: 't', kind, lanes: ['native-cold', 'browser-cold'], rounds: 5, seed: 1, fixtures: [{ name: 'fx', set: 'tuning', bytes: 1 }], sides: { base: { label: 'a' }, branch: { label: 'b' } } });
// Base: frame = settled + 0. Branch: settled 20% faster, but every branch frame starts 150 ms after its mark (post-finalize stall).
const browserRow = (side, round, settled, wait, frames = true) => ({ lane: 'browser-cold', fixture: 'fx', round, side, ok: true, fingerprint: 'f',
  interactiveMs: settled, geometryMs: settled, presentTimesFromChangeMs: frames ? [settled - 30, settled + wait] : null, host: {} });
const nativeRow = (side, round, ms) => ({ lane: 'native-cold', fixture: 'fx', round, side, ok: true, fingerprint: 'n', interactiveMs: ms, host: {} });
const rows = (branchFrames = true) => [0, 1, 2, 3, 4].flatMap((r) => [browserRow('base', r, 1000 + r, 0), browserRow('branch', r, 800 + r, 150, branchFrames || r !== 2),
  nativeRow('base', r, 500 + r), nativeRow('branch', r, 500 + r)]);

test('browser verdicts use the frame mark; the settled mark keeps its own row; native keeps interactiveMs', async () => {
  const { summarize } = await load('./load-scoreboard-report.mjs');
  const flat = { fx: { 'browser-cold': { frameMs: 0.01, interactiveMs: 0.01 }, 'native-cold': { interactiveMs: 0.01 } } };
  const s = summarize(plan(), rows(), { floors: flat });
  const lane = s.fixtures[0].lanes['browser-cold'];
  assert.equal(lane.verdicts.frameMs.baseMedian, 1002);
  assert.equal(lane.verdicts.frameMs.branchMedian, 952, 'branch frame = settled 802 + the 150 ms wait');
  assert.equal(lane.verdicts.interactiveMs.branchMedian, 802);
  assert.equal(lane.primary, lane.verdicts.frameMs, 'the lane summary reads the frame mark');
  assert.ok(lane.verdicts.interactiveMs.gain > lane.verdicts.frameMs.gain, 'the stall shows only under the frame mark');
  const native = s.fixtures[0].lanes['native-cold'];
  assert.equal(native.verdicts.frameMs, undefined, 'native has no frames: no frame-mark row');
  assert.equal(native.primary, native.verdicts.interactiveMs);
});

test('a browser sample without frame times leaves the frame-mark cell unverifiable, never judged on the settled mark', async () => {
  const { summarize } = await load('./load-scoreboard-report.mjs');
  const s = summarize(plan(), rows(false), { floors: { fx: { 'browser-cold': { frameMs: 0.01, interactiveMs: 0.01 }, 'native-cold': { interactiveMs: 0.01 } } } });
  const v = s.fixtures[0].lanes['browser-cold'].verdicts.frameMs;
  assert.match(v.verdict, /^inconclusive: unverifiable \(1 sample\(s\) without frame times/);
  assert.equal(v.pass, false);
  assert.deepEqual(s.laneSummary['browser-cold'].inconclusive, ['fx'], 'listed with the inconclusive cells');
  assert.equal(s.fixtures[0].lanes['browser-cold'].verdicts.interactiveMs.verdict, 'gain', 'the settled row is still judged');
});

test('rows with no frame times at all: the frame-mark cell is unverifiable, not dropped from the summary', async () => {
  const { summarize } = await load('./load-scoreboard-report.mjs');
  const old = rows().map((r) => ({ ...r, presentTimesFromChangeMs: undefined }));
  const s = summarize(plan(), old, { floors: { fx: { 'browser-cold': { frameMs: 0.01, interactiveMs: 0.01 } } } });
  assert.match(s.fixtures[0].lanes['browser-cold'].verdicts.frameMs.verdict, /^inconclusive: unverifiable \(10 sample/);
  assert.deepEqual(s.laneSummary['browser-cold'].inconclusive, ['fx']);
});

test('an A/A run records frame-mark floors beside the settled ones; a reference without them gives no frame verdict', async () => {
  const { summarize } = await load('./load-scoreboard-report.mjs');
  const aa = [0, 1, 2, 3, 4].flatMap((r) => [browserRow('base', r, 1000 + r * 10, 0), browserRow('branch', r, 1000 + r * 10, 0)]);
  const floors = summarize({ ...plan('aa'), lanes: ['browser-cold'] }, aa).floors.fx['browser-cold'];
  assert.ok(Number.isFinite(floors.frameMs) && Number.isFinite(floors.interactiveMs));
  const s = summarize(plan(), rows(), { floors: { fx: { 'browser-cold': { interactiveMs: 0.01 } } } });
  assert.match(s.fixtures[0].lanes['browser-cold'].verdicts.frameMs.verdict, /^inconclusive: no A\/A floor/);
});
