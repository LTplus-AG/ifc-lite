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

test('a consistent lean between two identical builds is contained by the recorded A/A floor', async () => {
  const { aaNoiseFloor, verdictFor } = await stats();
  // Measured, timed baseline v2: FZK native-cold, copies A and B of one binary (a ~30 ms load at 1 ms resolution).
  const aaFloor = aaNoiseFloor(pairs([55.8, 28.8, 32.8, 22.7, 24.9], [60.1, 25.2, 23.9, 30.4, 31.4]));
  assert.ok(aaFloor > 0.2, `A/A floor ${aaFloor}`);
  // An untimed smoke of the same pair, extended to five rounds, leaned ~9% one way in every round.
  const lean = pairs([32.4, 31.1, 28.0, 30.2, 29.5], [27.9, 28.4, 23.7, 27.6, 27.0]);
  assert.equal(verdictFor(lean, { aaFloor }).verdict, 'no significant difference');
  // Without the A/A floor, five consistent pairs are evidence of a difference: catching a systematic
  // difference between identical builds is the A/A floor's job (its |gain| term), not the run's own.
  assert.equal(verdictFor(lean).verdict, 'gain');
});

test('one outlier in the A/A cannot blind a consistent regression: the floor is interquartile, not the range or the bootstrap (timed baseline v2)', async () => {
  const { aaNoiseFloor, bootstrapHalfWidth, verdictFor } = await stats();
  // Measured: advanced_model browser-warm, A/A copies (one 1,938 ms outlier), then perf.sceneSnapshot=0 against main.
  const aaBase = [1138, 1173, 1080, 1188, 1938], aaBranch = [1173, 1145, 1155, 1084, 1180];
  const aaFloor = aaNoiseFloor(pairs(aaBase, aaBranch), { seed: 0x5eed });
  assert.ok(aaFloor < 0.15, `A/A floor ${aaFloor}`);
  assert.ok(bootstrapHalfWidth(pairs(aaBase, aaBranch), { seed: 0x5eed }) > 0.15, 'the 5-round bootstrap alone is outlier-dominated');
  const v = verdictFor(pairs([1120, 1207, 1170, 1121, 1132], [1626, 1497, 1591, 1550, 1482]), { aaFloor, seed: 0x5eed });
  assert.equal(v.verdict, 'regression');
  // The same A/A against itself stays quiet.
  assert.equal(verdictFor(pairs(aaBase, aaBranch), { seed: 0x5eed }).verdict, 'no significant difference');
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

test('a UI-quiet wait that hit its cap is not a measurement, flagged or inferred from older rows (review #9607)', async () => {
  const { uiQuietValue } = await stats();
  assert.equal(uiQuietValue({ interactiveMs: 2000, uiQuietMs: 2600, uiQuietTimedOut: false }), 2600);
  assert.equal(uiQuietValue({ interactiveMs: 2000, uiQuietMs: 21800, uiQuietTimedOut: true }), null);
  // Rows from a harness that did not record the flag: only a capped wait lands >= 19 s past readiness.
  assert.equal(uiQuietValue({ interactiveMs: 2000, uiQuietMs: 21700 }), null);
  assert.equal(uiQuietValue({ interactiveMs: 2000, uiQuietMs: 9000 }), 9000);
  assert.equal(uiQuietValue({ interactiveMs: 2000 }), null);
});

test('a reopen without a settled cache write or its expected snapshot is a failed sample, not a cache-hit measurement (review #9607)', async () => {
  const { warmPrepFailure } = await stats();
  assert.equal(warmPrepFailure({ open: 1, cacheWriteSettled: true, snapshotExpected: true }), null);
  assert.equal(warmPrepFailure({ open: 2, cacheWriteSettled: true, snapshotExpected: true, snapshotWritten: true }), null);
  assert.match(warmPrepFailure({ open: 1, cacheWriteSettled: false, snapshotExpected: true }), /cache write did not settle/);
  assert.match(warmPrepFailure({ open: 2, cacheWriteSettled: true, snapshotExpected: true, snapshotWritten: false }), /snapshot was not written/);
  // perf.sceneSnapshot=0 or an uncached tier: no snapshot is expected, so none missing is not a failure.
  assert.equal(warmPrepFailure({ open: 2, cacheWriteSettled: true, snapshotExpected: false, snapshotWritten: undefined }), null);
});

test('a bimodal metric in an A/A is no difference: the interquartile floor spans the mode split (timed baseline v2)', async () => {
  const { verdictFor } = await stats();
  // Measured on two copies of one build: FZK warm first geometry (~100 ms mode jump), ISSUE_129 warm peak memory (~868 / ~895 MiB).
  assert.equal(verdictFor(pairs([358, 463, 464, 344, 372], [470, 380, 488, 447, 465])).verdict, 'no significant difference');
  assert.equal(verdictFor(pairs([896, 894, 868, 891, 898], [903, 894, 868, 869, 868])).verdict, 'no significant difference');
});

test('a scene-snapshot write that times out makes the snapshot reopen a failed sample, not a valid warm one (review #9607 r4530369554)', async () => {
  const { prepareWarmOpen } = await snapshotRule();
  // Forced timeout: waitSceneSnapshots rejects the way Playwright's waitForFunction does after its 60 s budget.
  const timedOut = () => Promise.reject(new Error('page.waitForFunction: Timeout 60000ms exceeded.'));
  const timedOutPrep = await prepareWarmOpen({ open: 2, cacheWriteSettled: true, snapshotExpected: true, waitSnapshot: timedOut });
  assert.equal(timedOutPrep.snapshotWritten, false);
  assert.match(timedOutPrep.failure ?? '', /snapshot was not written/);
  // A written snapshot prepares a measurable reopen.
  const written = await prepareWarmOpen({ open: 2, cacheWriteSettled: true, snapshotExpected: true, waitSnapshot: () => Promise.resolve() });
  assert.deepEqual(written, { snapshotWritten: true, failure: null });
  // The first reopen and snapshot-less runs never wait (nothing to time out on); an unsettled cache write still fails them.
  let waited = 0;
  const count = () => { waited++; return Promise.resolve(); };
  assert.equal((await prepareWarmOpen({ open: 1, cacheWriteSettled: true, snapshotExpected: true, waitSnapshot: count })).failure, null);
  assert.equal((await prepareWarmOpen({ open: 2, cacheWriteSettled: true, snapshotExpected: false, waitSnapshot: count })).failure, null);
  assert.equal(waited, 0);
  assert.match((await prepareWarmOpen({ open: 1, cacheWriteSettled: false, snapshotExpected: true, waitSnapshot: count })).failure ?? '', /cache write did not settle/);
});

const lanesModule = () => load('./load-scoreboard-lanes.mjs');

test('browser-cold-early times from the pick: the boot-delayed input dispatch is inside its clock', async () => {
  const { rebaseToArm } = await lanesModule();
  const open = { inputDelayMs: 1900, firstFrameMs: 400, interactiveMs: 700, uiQuietMs: 900, geometryMs: 650, propsMs: 600,
    storeSettledMs: 680, settlePaintMs: 700, publishPaintMs: 690 };
  const early = rebaseToArm(open);
  assert.equal(early.interactiveMs, 2600);
  assert.equal(early.interactiveFromChangeMs, 700);
  assert.equal(early.firstFrameMs, 2300);
  assert.equal(early.uiQuietMs, 2800);
  assert.match(early.clockFrom, /^arm/);
  // A missing first frame stays missing rather than becoming the delay alone.
  assert.equal(rebaseToArm({ ...open, firstFrameMs: null }).firstFrameMs, null);
});

test('the first reopen waits until the stored cache entry stops changing (a snapshot written at cold end cannot race it)', async () => {
  const { stableSince } = await lanesModule();
  const obs = (pairs) => pairs.map(([at, sig]) => ({ at, sig }));
  // Snapshot lands at 1.2 s, then nothing changes: stable from 1.2 s once 3 s have passed.
  assert.equal(stableSince(obs([[0, 'a:0'], [600, 'a:0'], [1200, 'a:812'], [3000, 'a:812'], [4300, 'a:812']]), 3000), 1200);
  // Not yet 3 s since the last change.
  assert.equal(stableSince(obs([[0, 'a:0'], [1200, 'a:812'], [3000, 'a:812']]), 3000), null);
  assert.equal(stableSince([], 3000), null);
});

test('boot time-to-interactive ends at the last long task before the first 1 s quiet window', async () => {
  const { bootTimeToInteractive } = await lanesModule();
  // Shell ready at 900 ms; welcome scene 1,000-2,400 ms, probe 2,500-2,935 ms, then quiet; a late task at 5 s does not count.
  assert.equal(bootTimeToInteractive([[1000, 1400], [2500, 435], [5000, 80]], 900), 2935);
  assert.equal(bootTimeToInteractive([], 900), 900);
  // Tasks wholly before the shell was ready do not extend it.
  assert.equal(bootTimeToInteractive([[100, 300]], 900), 900);
});

test('the report summarizes the boot lane under its pseudo-fixture and counts snapshot adoption per reopen lane', async () => {
  const { summarize, BOOT_FIXTURE } = await report();
  const plan = { name: 't', kind: 'aa', lanes: ['boot', 'browser-warm1'], fixtures: [{ name: 'fx', set: 'tuning', bytes: 20 * 2 ** 20 }], sides: {} };
  const rows = [];
  for (let round = 0; round < 5; round++) for (const side of ['base', 'branch']) {
    rows.push({ lane: 'boot', fixture: BOOT_FIXTURE, round, side, ok: true, interactiveMs: 2900 + round, peakMemoryMiB: 700, idleJsMiB: 40, fingerprint: 'no model' });
    rows.push({ lane: 'browser-warm1', fixture: 'fx', round, side, ok: true, interactiveMs: 1000 + round, fingerprint: 'm=1',
      snapshotAdopted: [round < 3], snapshotPresentBeforeOpen: round < 3, loadPaths: ['cache'], cacheTiers: ['source'] });
  }
  const s = summarize(plan, rows);
  const boot = s.fixtures.find((f) => f.name === BOOT_FIXTURE);
  assert.equal(boot?.set, 'boot');
  assert.equal(boot.lanes.boot.verdicts.interactiveMs.verdict, 'no significant difference');
  assert.ok(boot.lanes.boot.verdicts.idleJsMiB, 'boot memory metrics get verdicts');
  const warm1 = s.fixtures.find((f) => f.name === 'fx').lanes['browser-warm1'].sides.base;
  assert.equal(warm1.snapshotAdoptedCount, 3);
  assert.equal(warm1.snapshotPresentBeforeOpenCount, 3);
});

test('idle wasm heaps add up per realm; a shared memory imported by several realms counts once, distinct ones all count (review #9740)', async () => {
  const { combineWasmRealms } = await lanesModule();
  const MiB = 2 ** 20;
  // One 128 MiB shared memory imported by two realms: counted once, upper bound shows both occurrences.
  const c = combineWasmRealms([{ own: 64 * MiB, shared: [], count: 1 }, { own: 32 * MiB, shared: [128 * MiB], count: 2 }, { own: 0, shared: [128 * MiB], count: 1 }]);
  assert.equal(c.ownBytes, 96 * MiB);
  assert.equal(c.sharedBytes, 128 * MiB);
  assert.equal(c.totalBytes, 224 * MiB);
  assert.equal(c.sharedBytesUpperBound, 256 * MiB);
  assert.equal(c.sharedAmbiguous, true);
  assert.equal(c.memories, 4);
  // Two distinct shared memories (page 64 MiB, worker 16 MiB) both count; the smaller one does not vanish.
  const d = combineWasmRealms([{ own: 0, shared: [64 * MiB], count: 1 }, { own: 0, shared: [16 * MiB], count: 1 }]);
  assert.equal(d.totalBytes, 80 * MiB);
  assert.equal(d.sharedAmbiguous, false);
  assert.equal(combineWasmRealms([]).totalBytes, 0);
});

test('a cache entry that was unreadable or never stopped changing fails the first reopen instead of passing as stable (review #9740)', async () => {
  const { entryStabilityFailure } = await lanesModule();
  assert.equal(entryStabilityFailure({ stable: true, snapshotPresent: false, waitedMs: 3100 }), null);
  assert.equal(entryStabilityFailure({ stable: true, snapshotPresent: true, waitedMs: 4200 }), null);
  assert.match(entryStabilityFailure({ stable: false, snapshotPresent: null, waitedMs: 40, error: 'indexedDB.open failed: UnknownError' }), /unreadable/);
  assert.match(entryStabilityFailure({ stable: false, snapshotPresent: true, waitedMs: 30000 }), /still changing/);
  assert.equal(entryStabilityFailure(undefined), null); // uncached tiers never wait
});

test('the early lane is per-element checked: its rows name the elements file its sample wrote (review #9740)', async () => {
  const { elementsFileFor } = await report();
  assert.equal(elementsFileFor({ lane: 'browser-cold-early', fixture: 'FZK', side: 'base', round: 3 }), 'FZK-base-r3-early-cold.elements.json');
  assert.equal(elementsFileFor({ lane: 'browser-cold', fixture: 'FZK', side: 'base', round: 3 }), 'FZK-base-r3-cold.elements.json');
  assert.equal(elementsFileFor({ lane: 'browser-warm1', fixture: 'FZK', side: 'branch', round: 0 }), 'FZK-branch-r0-warm1.elements.json');
  assert.equal(elementsFileFor({ lane: 'browser-warm', fixture: 'FZK', side: 'branch', round: 0, warmOpens: [{}, {}] }), 'FZK-branch-r0-warm2.elements.json');
});
