/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The decision rule the load hill-climb accepts or rejects optimisations by:
// a change counts only when |gain| >= 2 x noise floor, the floor being the
// larger of the recorded A/A floor and the run's own paired-bootstrap floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The modules under test are loaded inside each test, not at the top of the
// file. Without them (the revert oracle reverses this PR's production hunks),
// every test must still be collected and fail on its own assertion, instead of
// the whole file dying at import with nothing asserted.
async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'}); run \`node --input-type=module -e "import('${path}')"\` from scripts/perf for the cause`);
  return mod;
}
const stats = () => load('./load-scoreboard-stats.mjs');
const report = () => load('./load-scoreboard-report.mjs');
const snapshotRule = () => load('./viewer-scene-snapshot.mjs');

const pairs = (base, branch) => base.map((b, i) => [b, branch[i]]);
// Five rounds with about +-2% scatter, the shape of a quiet A/A cohort.
const A = [1000, 1012, 991, 1005, 998];
const A2 = [1003, 995, 1010, 999, 1006];

test('median and spread ignore missing values', async () => {
  const { median, relativeSpread } = await stats();
  assert.equal(median([3, null, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(relativeSpread([90, 100, 110]), 0.2);
  assert.equal(relativeSpread([100]), null);
});

test('gain is the fraction of the base median the branch saves', async () => {
  const { gainOf } = await stats();
  assert.ok(Math.abs(gainOf([100, 100], [80, 80]) - 0.2) < 1e-12);
  assert.ok(Math.abs(gainOf([100], [130]) + 0.3) < 1e-12);
  assert.equal(gainOf([0], [5]), null);
});

test('the paired bootstrap is reproducible and widens with scatter', async () => {
  const { bootstrapHalfWidth } = await stats();
  const quiet = bootstrapHalfWidth(pairs(A, A2), { seed: 7 });
  assert.equal(quiet, bootstrapHalfWidth(pairs(A, A2), { seed: 7 }));
  const noisy = bootstrapHalfWidth(pairs([1000, 1300, 800, 1150, 900], [1100, 850, 1250, 950, 1020]), { seed: 7 });
  assert.ok(noisy > quiet * 3, `${noisy} vs ${quiet}`);
  assert.equal(bootstrapHalfWidth([[1, 2]]), null);
});

test('an A/A comparison of two identical builds is no significant difference', async () => {
  const { verdictFor } = await stats();
  const v = verdictFor(pairs(A, A2));
  assert.equal(v.verdict, 'no significant difference');
  assert.equal(v.pass, false);
  assert.equal(v.regression, false);
});

test('a 30% slowdown is flagged as a regression', async () => {
  const { verdictFor } = await stats();
  const v = verdictFor(pairs(A, A2.map((x) => x * 1.3)));
  assert.equal(v.verdict, 'regression');
  assert.equal(v.regression, true);
  assert.ok(v.gain < -0.25);
});

test('a gain passes only when it clears twice the larger of the A/A floor and the own floor', async () => {
  const { verdictFor } = await stats();
  const faster = A2.map((x) => x * 0.9);
  assert.equal(verdictFor(pairs(A, faster)).verdict, 'gain');
  // The recorded A/A floor binds even when this run happened to be quiet: 10% < 2 x 6%.
  const bound = verdictFor(pairs(A, faster), { aaFloor: 0.06 });
  assert.equal(bound.noiseFloor, 0.06);
  assert.equal(bound.verdict, 'no significant difference');
  assert.equal(verdictFor(pairs(A, faster), { aaFloor: 0.04 }).verdict, 'gain');
});

test('a difference below the absolute resolution never counts', async () => {
  const { verdictFor } = await stats();
  const v = verdictFor(pairs([10, 10, 10, 10, 10], [9.6, 9.6, 9.6, 9.6, 9.6]), { minAbs: 1 });
  assert.equal(v.verdict, 'no significant difference');
});

test('failed loads stay in the data: more branch failures is a regression, too few samples is inconclusive', async () => {
  const { verdictFor } = await stats();
  const withFailures = verdictFor([[1000, null], [1010, 990], [995, null], [1003, 1001], [999, 1000]], { failures: { base: 0, branch: 2 } });
  assert.equal(withFailures.verdict, 'regression: more failed loads');
  const thin = verdictFor([[1000, 990], [null, null], [null, null], [1003, null], [999, null]], { failures: { base: 2, branch: 3 } });
  assert.equal(thin.verdict, 'regression: more failed loads');
  const thinEqual = verdictFor([[1000, 990], [null, null], [null, null], [1003, 1001], [null, null]], { failures: { base: 3, branch: 3 } });
  assert.match(thinEqual.verdict, /^inconclusive/);
  // Protocol minimum: five successful samples a side, even with no failures.
  assert.match(verdictFor(pairs(A.slice(0, 4), A2.slice(0, 4).map((x) => x * 1.3))).verdict, /^inconclusive/);
});

test('the A/A floor includes the systematic difference between identical builds', async () => {
  const { aaNoiseFloor } = await stats();
  const skewed = aaNoiseFloor(pairs(A, A2.map((x) => x * 1.05)), { seed: 3 });
  assert.ok(skewed >= 0.045, String(skewed));
  assert.ok(aaNoiseFloor(pairs(A, A2), { seed: 3 }) < 0.03);
});

test('stage shares union concurrent intervals and clip to the load window', async () => {
  const { rankShares, stageShares, unionLength } = await stats();
  assert.equal(unionLength([[0, 10], [5, 10], [30, 5]]), 20);
  const shares = stageShares({ geometry: [[0, 40], [20, 40]], parser: [[-10, 30]], tail: [[90, 50]] }, 100);
  assert.equal(shares.geometry, 0.6);
  assert.equal(shares.parser, 0.2);
  assert.equal(shares.tail, 0.1);
  const ranked = rankShares([shares, { ...shares, parser: 0.4 }]);
  assert.deepEqual(ranked.map((r) => r.stage), ['geometry', 'parser', 'tail']);
});

test('browser stages skip milestones, which span from the load start to the event, and mark umbrella spans', async () => {
  const { browserStages } = await stats();
  const { byName, byGroup } = browserStages([{ spans: [['geometry.streamComplete', 'main', 0, 900, 1, 1, null],
    ['parser.worker', 'main', 5, 300, 0, 2, null], ['parser.hydrate', 'parser', 60, 100, 0, 3, 2]] }]);
  assert.deepEqual(Object.keys(byName).sort(), ['parser.hydrate', 'parser.worker*']);
  assert.equal(byGroup.parser.length, 2);
});

test('native stages account for the whole cold load exactly once', async () => {
  const { nativeStages } = await stats();
  const row = { fileReadMs: 12.5, parseMs: 300, entityScanMs: 120, lookupMs: 40, preprocessMs: 90, geometryMs: 650, totalMs: 960, allWallMs: [1010], fullLoadWallMs: 1022.5 };
  const stages = nativeStages(row);
  const sum = Object.values(stages).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - row.fullLoadWallMs) < 1e-9, `${sum}`);
  assert.equal(stages['parse.other'], 50);
  assert.equal(stages['metadata.tail'], 50);
});

test('cache tiers follow the viewer thresholds', async () => {
  const { expectedCacheTier } = await stats();
  const MB = 2 ** 20;
  assert.match(expectedCacheTier(2.4 * MB), /^none/);
  assert.match(expectedCacheTier(49 * MB), /^source/);
  assert.match(expectedCacheTier(177 * MB), /^mesh-only/);
  assert.match(expectedCacheTier(401 * MB), /^none/);
});

test('the report keeps failures, flags changed output and exports per-metric floors', async () => {
  const { summarize } = await report();
  const plan = { name: 't', lanes: ['native-cold'], fixtures: [{ name: 'fx', set: 'tuning', bytes: 1 }], sides: {} };
  const rows = [];
  for (let round = 0; round < 5; round++) {
    rows.push({ lane: 'native-cold', fixture: 'fx', round, side: 'base', ok: true, interactiveMs: A[round], peakMemoryMiB: 200, fingerprint: 'm=1' });
    rows.push({ lane: 'native-cold', fixture: 'fx', round, side: 'branch', ok: round !== 2, error: round === 2 ? 'boom' : undefined,
      interactiveMs: A2[round] * 1.4, peakMemoryMiB: 200, fingerprint: 'm=2' });
  }
  const lane = summarize(plan, rows).fixtures[0].lanes['native-cold'];
  assert.equal(lane.sides.branch.failed, 1);
  assert.deepEqual(lane.sides.branch.errors, ['r2: boom']);
  assert.equal(lane.output, 'CHANGED');
  assert.equal(lane.primary.regression, true);
  assert.ok(Number.isFinite(lane.floors.interactiveMs));
});

test('browser shares name the untraced part of the load and keep milestone times', async () => {
  const { browserShares } = await stats();
  const { shares, milestones } = browserShares([{ spans: [['cache.storeReady', 'main', 0, 700, 1, 1, null],
    ['cache.decode', 'main', 100, 200, 0, 2, null], ['search.tier1', 'main', 200, 300, 0, 3, null]] }], 1000);
  assert.ok(Math.abs(shares['(no span)'] - 0.6) < 1e-12);
  assert.equal(milestones['cache.storeReady'], 700);
});

test('per-element output diff ignores order and names missing, extra and changed elements', async () => {
  const { diffElements } = await stats();
  assert.equal(diffElements({ 1: 'a', 2: 'b' }, { 2: 'b', 1: 'a' }).identical, true);
  const d = diffElements({ 1: 'a', 2: 'b', 3: 'c' }, { 2: 'b', 3: 'x', 4: 'd' });
  assert.equal(d.identical, false);
  assert.deepEqual([d.onlyBase, d.onlyBranch, d.changed], [1, 1, 1]);
  assert.deepEqual(d.examples, { onlyBase: [1], onlyBranch: [4], changed: [3] });
  // Two loads without element hashes (e.g. cache hits) are unverifiable, not identical.
  const empty = diffElements({}, {});
  assert.equal(empty.identical, false);
  assert.equal(empty.unverifiable, true);
});

test('H5: a cell with fewer than three samples lists them instead of reporting a median', async () => {
  const { median } = await stats();
  const { renderMarkdown, summarize } = await report();
  const plan = { name: 't', kind: 'compare', lanes: ['native-cold'], rounds: 2, seed: 1, fixtures: [{ name: 'fx', set: 'tuning', bytes: 1 }],
    sides: { base: { label: 'a' }, branch: { label: 'b' } } };
  const rows = [0, 1].flatMap((round) => ['base', 'branch'].map((side) => ({ lane: 'native-cold', fixture: 'fx', round, side, ok: true,
    interactiveMs: round ? 6644 : 1705, peakMemoryMiB: 20, fingerprint: 'm=1' })));
  const md = renderMarkdown(summarize(plan, rows), plan, null);
  assert.match(md, /n=2: 1,705, 6,644/);
  assert.doesNotMatch(md, /4,175/); // the mean of two, which an n=2 "median" would print
});

test('an A/A whose few pairs all lean one way is not a gain: the floor covers the samples own scatter', async () => {
  const { bootstrapHalfWidth, ownNoiseFloor, verdictFor } = await stats();
  // Measured: native FZK, two copies of one binary, branch 3-4 ms faster in every round of a 28 ms load.
  const base = [32.4, 31.1, 28.0, 30.2, 29.5], branch = [27.9, 28.4, 23.7, 27.6, 27.0];
  assert.ok(bootstrapHalfWidth(pairs(base, branch), { seed: 1 }) < 0.06, 'the bootstrap alone collapses');
  assert.ok(ownNoiseFloor(pairs(base, branch), { seed: 1 }) >= 0.07);
  assert.equal(verdictFor(pairs(base, branch)).verdict, 'no significant difference');
});

test('a GPU health read that failed is not a healthy sample', async () => {
  const { gpuUnhealthy } = await stats();
  assert.match(gpuUnhealthy({ error: 'page.evaluate: Target closed' }), /unreadable/);
  assert.match(gpuUnhealthy(null), /unreadable/);
  assert.match(gpuUnhealthy({ contaminated: true, reasons: ['lost'] }), /device lost/);
  assert.equal(gpuUnhealthy({ contaminated: false, reasons: [] }), null);
});

test('a failure while preparing reopen 2 belongs to reopen 2, not to the clean first reopen (review #9607)', async () => {
  const { failedOpenIndex } = await stats();
  assert.equal(failedOpenIndex('cold-shell'), 0);
  assert.equal(failedOpenIndex('boot'), 0);
  assert.equal(failedOpenIndex('warm1-prep'), 1);
  assert.equal(failedOpenIndex('warm2-prep'), 2);
  assert.equal(failedOpenIndex('warm2-shell'), 2);
  assert.equal(failedOpenIndex('warm2'), 2);
});

test('the snapshot wait follows the viewer rule: on unless perf.sceneSnapshot is set to anything but 1/true (review #9607)', async () => {
  const { sceneSnapshotsEnabled, expectSceneSnapshot } = await snapshotRule();
  // Default (absent) is on, as sceneSnapshotLoad.ts snapshotsEnabled() decides; scenoptic-bench used to wait only for =1.
  assert.equal(sceneSnapshotsEnabled('?perfTrace=1'), true);
  assert.equal(sceneSnapshotsEnabled('perfTrace=1&perf.sceneSnapshot=1'), true);
  assert.equal(sceneSnapshotsEnabled('?perf.sceneSnapshot=true'), true);
  // Every other value turns it off in the product, not only =0.
  for (const off of ['0', 'false', 'off', '2']) assert.equal(sceneSnapshotsEnabled(`?perf.sceneSnapshot=${off}`), false, off);
  assert.equal(expectSceneSnapshot({ query: '?perfTrace=1', files: 1, cached: true }), true);
  assert.equal(expectSceneSnapshot({ query: '?perfTrace=1', files: 1, cached: false }), false, 'uncached tiers never write one');
  assert.equal(expectSceneSnapshot({ query: '?perfTrace=1', files: 2, cached: true }), false, 'federated hits keep their path');
});
