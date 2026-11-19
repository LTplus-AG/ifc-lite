/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pure half of the #9584 paired RSS harness: the ordering, the noise
// guard, the identity rule and the verdict, none of which should need a
// cargo build or a 327 MB fixture to be trusted.

import assert from 'node:assert/strict';
import test from 'node:test';
import { seededRand } from './ab-order.mjs';
import { InvalidRuns, VARIANT_KEYS, formatReport, groupRuns, outputName, summarize, variantOrder } from './cache-stream-report.mjs';

const MODEL = 'ara3d/AC20-FZK-Haus.ifc';
const run = (variant, round, peakMiB, { hash = 'aaaa', elapsedMs = 1000, model = MODEL, stats } = {}) => ({
  model,
  variant,
  round,
  status: 'ok',
  peakRssBytes: peakMiB * 1024 * 1024,
  elapsedMs,
  outputSha256: hash,
  outputBytes: 4096,
  stats: { meshCount: 285, chunkCells: 5, peakOpenChunkBytes: 1024, cacheBytes: 999, ...stats },
});
/** Three variants over `rounds` rounds, each variant's peaks given in MiB. */
const matrix = (peaks, extra = {}) =>
  VARIANT_KEYS.flatMap((variant) => peaks[variant].map((peak, i) => run(variant, i + 1, peak, extra[variant] ?? {})));

test('variantOrder refuses a round count it cannot order', () => {
  assert.throws(() => variantOrder(0), /positive integer/);
  assert.throws(() => variantOrder(2.5), /positive integer/);
  assert.throws(() => variantOrder(3, []), /at least one variant/);
});

test('every round is a permutation of the variants, and leads are balanced', () => {
  const rounds = variantOrder(6, VARIANT_KEYS, seededRand(7));
  assert.equal(rounds.length, 6);
  for (const order of rounds) assert.deepEqual([...order].sort(), [...VARIANT_KEYS].sort());
  const leads = new Map(VARIANT_KEYS.map((k) => [k, 0]));
  for (const [first] of rounds) leads.set(first, leads.get(first) + 1);
  // Six rounds over three variants: each leads exactly twice, so a penalty
  // tied to running first cannot accumulate on one side.
  assert.deepEqual([...leads.values()], [2, 2, 2]);
});

test('leads stay within one of each other when rounds do not divide evenly', () => {
  const leads = new Map(VARIANT_KEYS.map((k) => [k, 0]));
  for (const [first] of variantOrder(5, VARIANT_KEYS, seededRand(3))) leads.set(first, leads.get(first) + 1);
  const counts = [...leads.values()];
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `unbalanced leads: ${counts.join(',')}`);
});

test('a seed replays the same ordering', () => {
  assert.deepEqual(variantOrder(5, VARIANT_KEYS, seededRand(42)), variantOrder(5, VARIANT_KEYS, seededRand(42)));
});

test('groupRuns refuses rows a verdict cannot be built from', () => {
  assert.throws(() => groupRuns([]), InvalidRuns);
  assert.throws(() => groupRuns([{ ...run('base-inmem', 1, 10), variant: 'nope' }]), /must be one of/);
  assert.throws(() => groupRuns([{ ...run('base-inmem', 1, 10), model: '' }]), /missing the model/);
  assert.throws(() => groupRuns([{ ...run('base-inmem', 1, 10), peakRssBytes: Number.NaN }]), /finite nonnegative/);
  assert.throws(() => groupRuns([{ ...run('base-inmem', 1, 10), outputSha256: '' }]), /outputSha256/);
});

test('a failed run is kept as data but never enters a median', () => {
  const rows = [...matrix({ 'base-inmem': [100, 100], 'head-inmem': [100, 100], 'head-streamed': [50, 50] })];
  rows.push({ model: MODEL, variant: 'head-streamed', round: 3, status: 'failed', error: 'exit 1: TooLarge' });
  const { models } = summarize(rows);
  const streamed = models[0].variants.find((v) => v.variant === 'head-streamed');
  assert.equal(streamed.rounds, 2);
  assert.equal(models[0].failures.length, 1);
  assert.match(models[0].failures[0].error, /TooLarge/);
  assert.equal(models[0].incomplete, false);
});

test('a variant with no successful run makes the model incomplete, not a win', () => {
  const rows = [run('base-inmem', 1, 100), run('head-inmem', 1, 100),
    { model: MODEL, variant: 'head-streamed', round: 1, status: 'failed', error: 'killed' }];
  const summary = summarize(rows);
  assert.equal(summary.incomplete, true);
  assert.deepEqual(summary.models[0].missing, ['head-streamed']);
  assert.match(formatReport(summary).join('\n'), /Incomplete/);
});

test('a drop well outside the baseline spread is a real saving, attributed three ways', () => {
  const summary = summarize(matrix({
    'base-inmem': [1000, 1010, 1005, 1000, 1008],
    'head-inmem': [990, 1000, 995, 992, 998],
    'head-streamed': [700, 705, 710, 702, 704],
  }));
  const claim = summary.models[0].comparisons.find((c) => c.to === 'head-streamed' && c.from === 'base-inmem' && c.metric === 'peakRssBytes');
  assert.equal(claim.real, true);
  assert.equal(claim.direction, 'lower');
  assert.ok(claim.deltaPct < -25, `expected a large drop, got ${claim.deltaPct}`);
  // The control says the branch alone moved almost nothing, so the saving
  // belongs to the writer rather than to everything else on the branch.
  const control = summary.models[0].comparisons.find((c) => c.to === 'head-inmem' && c.metric === 'peakRssBytes');
  assert.equal(control.real, false);
  const writer = summary.models[0].comparisons.find((c) => c.from === 'head-inmem' && c.metric === 'peakRssBytes');
  assert.equal(writer.real, true);
  assert.equal(summary.identityBroken, false);
  assert.equal(summary.underSampled, false);
});

test('the noise floor is the noisier side, not only the baseline', () => {
  // A quiet baseline and a streamed side swinging ±20%: a 10% "saving" read
  // against the baseline alone would pass, and it is not a reading.
  const summary = summarize(matrix({
    'base-inmem': [1000, 1000, 1000, 1000, 1000],
    'head-inmem': [1000, 1000, 1000, 1000, 1000],
    'head-streamed': [810, 900, 990, 900, 900],
  }));
  const claim = summary.models[0].comparisons.find((c) => c.to === 'head-streamed' && c.from === 'base-inmem' && c.metric === 'peakRssBytes');
  assert.ok(claim.noisePct > 15, `expected the streamed side's own spread, got ${claim.noisePct}`);
  assert.equal(claim.real, false);
});

test('a move inside the baseline spread, or under 3%, is noise', () => {
  const summary = summarize(matrix({
    'base-inmem': [1000, 1000, 1000, 1000, 1000],
    'head-inmem': [1000, 1000, 1000, 1000, 1000],
    'head-streamed': [980, 980, 980, 980, 980],
  }));
  const claim = summary.models[0].comparisons.find((c) => c.to === 'head-streamed' && c.from === 'base-inmem' && c.metric === 'peakRssBytes');
  assert.equal(claim.real, false, 'a 2% move on a silent baseline must not read as a saving');
  const report = formatReport(summary).join('\n');
  assert.match(report, /within noise/);
  // A model's acceptance delta is always printed, win or not: "within noise"
  // without the number it was within is not a result.
  assert.match(report, /-2\.0% — within noise/);
});

test('a real move in a non-acceptance comparison is not left in a footnote', () => {
  // The writer's saving is real while base→streamed is flat: the branch gave
  // back elsewhere exactly what the writer saved, and the verdict must say so.
  const summary = summarize(matrix({
    'base-inmem': [1000, 1000, 1000, 1000, 1000],
    'head-inmem': [1300, 1300, 1300, 1300, 1300],
    'head-streamed': [1000, 1000, 1000, 1000, 1000],
  }));
  const report = formatReport(summary).join('\n');
  assert.match(report, /Other moves outside noise/);
  assert.match(report, /head in-memory vs baseline peak RSS \+30\.0%/);
  assert.match(report, /streamed vs head in-memory peak RSS -23\.1%/);
});

test('variants that disagree on the bytes fail the run', () => {
  const summary = summarize(matrix(
    { 'base-inmem': [100, 100], 'head-inmem': [100, 100], 'head-streamed': [50, 50] },
    { 'head-streamed': { hash: 'bbbb' } }
  ));
  assert.equal(summary.identityBroken, true);
  assert.equal(summary.unstable, false);
  const report = formatReport(summary).join('\n');
  assert.match(report, /disagree on the bytes/);
  assert.match(report, /Output identity failed/);
});

test('one variant writing different bytes between rounds is non-determinism', () => {
  const rows = [...matrix({ 'base-inmem': [100, 100], 'head-inmem': [100, 100], 'head-streamed': [50, 50] })];
  rows.find((r) => r.variant === 'head-streamed' && r.round === 2).outputSha256 = 'cccc';
  const summary = summarize(rows);
  assert.equal(summary.unstable, true);
  assert.match(formatReport(summary).join('\n'), /different bytes between rounds/);
});

test('fewer than five rounds is a smoke run, and the report says so', () => {
  const summary = summarize(matrix({ 'base-inmem': [100], 'head-inmem': [100], 'head-streamed': [50] }));
  assert.equal(summary.underSampled, true);
  assert.match(formatReport(summary).join('\n'), /not acceptance evidence/);
});

test('the report carries the provenance a later reader needs', () => {
  const summary = summarize(matrix({ 'base-inmem': [100, 100], 'head-inmem': [100, 100], 'head-streamed': [50, 50] }));
  const report = formatReport(summary, {
    baseSha: 'ee77162e', headSha: 'e8bd18ee', profile: 'release', threads: 10, iters: 5,
    toolchain: 'rustc 1.90.0', toolchainPinned: 'nightly-2026-01-01',
    fixtures: [{ path: MODEL, sizeBytes: 2526511, sha256: 'd42ab0dee01173106c16cd823b4614ef', matchesManifest: true }],
  }).join('\n');
  for (const needle of ['ee77162e', 'e8bd18ee', 'RAYON_NUM_THREADS', 'rustc 1.90.0', MODEL, 'byte-identical', 'chunkCells']) {
    assert.ok(report.includes(needle), `report is missing ${needle}`);
  }
});

test('two models are summarized independently', () => {
  const other = 'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc';
  const rows = [
    ...matrix({ 'base-inmem': [100, 100], 'head-inmem': [100, 100], 'head-streamed': [50, 50] }),
    ...VARIANT_KEYS.flatMap((v) => [1, 2].map((i) => run(v, i, 1500, { model: other, hash: 'dddd' }))),
  ];
  const summary = summarize(rows);
  assert.deepEqual(summary.models.map((m) => m.model), [MODEL, other]);
  assert.equal(summary.identityBroken, false);
});

test('kept outputs from different models never share a name', () => {
  // louistrue on 8e6872d457: two fixtures, one round, --keep-outputs kept
  // three files, all the second fixture's, because the name was only the
  // variant and round.
  const models = ['various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc', 'ara3d/AC20-FZK-Haus.ifc', 'other/AC20-FZK-Haus.ifc'];
  const names = models.flatMap((model, fixtureIndex) =>
    VARIANT_KEYS.flatMap((variant) => [0, 1, 2].map((round) => outputName({ fixtureIndex, model, variant, round }))));
  assert.equal(new Set(names).size, names.length, 'one file per fixture, variant and round');
  assert.equal(outputName({ fixtureIndex: 0, model: models[0], variant: 'head-streamed', round: 3 }),
    '00-O-S1-BWK-BIM_architectural_-_BIM_bouwkundig-head-streamed-r3.ifclite');
});

test('a model where no writer produced output is incomplete, not a disagreement', () => {
  const failed = (variant) => ({ model: MODEL, variant, round: 1, status: 'failed', error: 'exit 1' });
  const summary = summarize(VARIANT_KEYS.map(failed));
  assert.equal(summary.incomplete, true);
  assert.equal(summary.identityBroken, false, 'no digests, so nothing disagrees');
  const report = formatReport(summary).join('\n');
  assert.doesNotMatch(report, /disagree on the bytes/);
  assert.doesNotMatch(report, /byte-identical/);
  assert.match(report, /not established\*\*: only 0 of 3 writers/);
  assert.match(report, /Incomplete/);
});

test('two in-memory writers agreeing with the streamed one failed is not three-way identity', () => {
  const rows = [
    ...matrix({ 'base-inmem': [100, 100], 'head-inmem': [100, 100], 'head-streamed': [] }),
    { model: MODEL, variant: 'head-streamed', round: 1, status: 'failed', error: 'exit 1' },
  ];
  const summary = summarize(rows, { minRounds: 2 });
  assert.equal(summary.incomplete, true);
  assert.equal(summary.identityBroken, false);
  assert.equal(summary.models[0].identity.agrees, false);
  const report = formatReport(summary).join('\n');
  assert.doesNotMatch(report, /byte-identical/);
  assert.match(report, /only 2 of 3 writers produced output \(base-inmem, head-inmem\)/);
});

test('two writers that wrote different bytes disagree even with the third missing', () => {
  const rows = matrix(
    { 'base-inmem': [100, 100], 'head-inmem': [100, 100], 'head-streamed': [] },
    { 'head-inmem': { hash: 'bbbb' } }
  );
  const summary = summarize(rows, { minRounds: 2 });
  assert.equal(summary.identityBroken, true);
  assert.match(formatReport(summary).join('\n'), /disagree on the bytes/);
});
