/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, summarize } from './load-scoreboard-report.mjs';
import { metadataMarkOf } from './load-scoreboard-report-sections.mjs';

const lanes = ['browser-cold', 'browser-warm1', 'browser-warm', 'native-cold'];
const plan = (reopenVerdictMark) => ({ name: 'metadata-mark', kind: 'compare', lanes, rounds: 5, seed: 1,
  ...(reopenVerdictMark ? { reopenVerdictMark } : {}), fixtures: [{ name: 'fx', set: 'tuning', bytes: 1 }],
  sides: { base: { label: 'base' }, branch: { label: 'branch' } } });
const row = (lane, side, round, settled, metadata = 200) => ({ lane, fixture: 'fx', side, round, ok: true,
  interactiveMs: settled, geometryMs: 300, presentTimesFromChangeMs: [100, 250, 350, 500],
  ...(metadata === undefined ? {} : { milestones: { 'load.metadataInteractive': metadata } }), fingerprint: 'same', host: {} });
const samples = () => lanes.flatMap((lane) => [0, 1, 2, 3, 4].flatMap((round) => ['base', 'branch'].map((side) => {
  const settled = lane === 'browser-warm1' ? 450 + round : lane === 'browser-warm' ? 460 + round
    : lane === 'browser-cold' ? 470 + round : 700 + round;
  return row(lane, side, round, settled, lane.startsWith('browser-warm') ? 320 : undefined);
})));
const floors = { fx: Object.fromEntries(lanes.map((lane) => [lane, { frameMs: 0.01, interactiveMs: 0.01, metadataFrameMs: 0.01 }])) };

test('metadata mark uses the first frame at or after its milestone and reports the old-mark hold', () => {
  const mark = metadataMarkOf({ geometryMs: 300, interactiveMs: 450, presentTimesFromChangeMs: [350, 400, 500],
    trace: [{ spans: [['load.metadataInteractive', null, 375, 0, true, 1, null]] }] });
  assert.deepEqual(mark, { metadataFrameMs: 400, holdMs: 50 });
  const late = metadataMarkOf({ geometryMs: 300, interactiveMs: 450, presentTimesFromChangeMs: [350, 400, 500],
    milestones: { 'load.metadataInteractive': 480 } });
  assert.deepEqual(late, { metadataFrameMs: 450, holdMs: 0 }, 'a milestone after scene completion is capped at the old mark');
});

test('a late metadata milestone with no later captured frame is capped at the old mark (review #10210)', () => {
  const mark = metadataMarkOf({ geometryMs: 300, interactiveMs: 450, presentTimesFromChangeMs: [350, 400, 470],
    milestones: { 'load.metadataInteractive': 480 } });
  assert.deepEqual(mark, { metadataFrameMs: 450, holdMs: 0 });
});

test('missing metadata milestones make reopen cells explicitly unverifiable and leave cold lanes on frame verdicts', () => {
  const absent = samples().map((sample) => sample.lane === 'browser-warm1' ? { ...sample, milestones: undefined } : sample);
  const summary = summarize(plan('metadata'), absent, { floors });
  const reopen = summary.fixtures[0].lanes['browser-warm1'];
  assert.match(reopen.verdicts.metadataFrameMs.verdict, /^inconclusive: unverifiable \(10 sample\(s\) without the metadata mark\)$/);
  assert.deepEqual(summary.laneSummary['browser-warm1'].inconclusive, ['fx']);
  assert.equal(summary.fixtures[0].lanes['browser-cold'].primary, summary.fixtures[0].lanes['browser-cold'].verdicts.frameMs);
  assert.equal(summary.fixtures[0].lanes['native-cold'].primary, summary.fixtures[0].lanes['native-cold'].verdicts.interactiveMs);
});

test('default frame verdict is unchanged, while metadata selection changes only reopen lanes', () => {
  const base = samples();
  const defaultSummary = summarize(plan(), base, { floors });
  const explicitFrame = summarize(plan('frame'), base, { floors });
  const selected = summarize(plan('metadata'), base, { floors });
  const old = defaultSummary.fixtures[0].lanes;
  const explicit = explicitFrame.fixtures[0].lanes;
  const next = selected.fixtures[0].lanes;
  for (const lane of lanes) {
    const verdicts = (value) => Object.fromEntries(Object.entries(value[lane].verdicts).filter(([key]) => key !== 'metadataFrameMs'));
    assert.deepEqual(verdicts(old), verdicts(explicit), `${lane}: implicit default keeps the prior verdict data`);
    assert.equal(old[lane].verdicts.frameMs?.verdict, next[lane].verdicts.frameMs?.verdict);
    assert.equal(old[lane].verdicts.interactiveMs?.verdict, next[lane].verdicts.interactiveMs?.verdict);
  }
  for (const lane of ['browser-warm1', 'browser-warm']) {
    assert.equal(old[lane].primary, old[lane].verdicts.frameMs);
    assert.equal(next[lane].primary, next[lane].verdicts.metadataFrameMs);
    assert.equal(next[lane].verdicts.metadataFrameMs.baseMedian, 350);
    const oldMedian = lane === 'browser-warm1' ? 452 : 462;
    const holdStart = lane === 'browser-warm1' ? 100 : 110;
    assert.equal(next[lane].verdicts.frameMs.baseMedian, oldMedian);
    assert.deepEqual(next[lane].bothMarks.base.holdValues, [holdStart, holdStart + 1, holdStart + 2, holdStart + 3, holdStart + 4]);
  }
  assert.equal(next['browser-cold'].primary, next['browser-cold'].verdicts.frameMs);
  assert.equal(next['native-cold'].primary, next['native-cold'].verdicts.interactiveMs);
  assert.match(renderMarkdown(selected, plan('metadata'), { segments: [] }), /102 \[100-104\] n=5/);
});

test('A/A runs record metadata frame floors, and a reference without them is inconclusive', () => {
  const aa = summarize({ ...plan(), kind: 'aa' }, samples());
  assert.ok(Number.isFinite(aa.floors.fx['browser-warm1'].metadataFrameMs));
  const noReferenceFloor = summarize(plan('metadata'), samples(), { floors: { fx: { 'browser-warm1': { frameMs: 0.01, interactiveMs: 0.01 } } } });
  assert.match(noReferenceFloor.fixtures[0].lanes['browser-warm1'].verdicts.metadataFrameMs.verdict, /^inconclusive: no A\/A floor/);
});

test('the metadata mark does not wait for the geometry restore (review finding on #10210)', () => {
  // Milestone 200 ms, complete frame 300 ms, frames 250/350 ms, restore (geometryMs) ends 300 ms.
  const mark = metadataMarkOf({ geometryMs: 300, interactiveMs: 340, completeFrameMs: 300, presentTimesFromChangeMs: [250, 350],
    milestones: { 'load.metadataInteractive': 200 } });
  assert.deepEqual(mark, { metadataFrameMs: 350, holdMs: 0 }, 'the complete-frame guard selects the 350 ms frame');
  // A trace without the stored-scene paint field still floors at the milestone only.
  const noPaint = metadataMarkOf({ geometryMs: 300, interactiveMs: 340, presentTimesFromChangeMs: [250, 350],
    milestones: { 'load.metadataInteractive': 200 } });
  assert.equal(noPaint.metadataFrameMs, 250);
});
