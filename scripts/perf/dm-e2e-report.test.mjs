/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Unit tests for the pure half of the #9582 end-to-end A/B harness. Every
// number here is SYNTHETIC test data, not a measurement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidRuns,
  formatReport,
  groupRuns,
  median,
  parsePeakRss,
  pctDelta,
  spreadPct,
  summarize,
} from './dm-e2e-report.mjs';

const run = (side, variant, overrides = {}) => ({
  side,
  variant,
  round: 1,
  peakRssBytes: 1024 * 1024 * 1000,
  parseMs: 300,
  geometryMs: 500,
  totalMs: 900,
  geometryDigest: 'geo-same',
  dataModelDigest: 'dm-same',
  totalEntities: 1_000_000,
  dataModelBytes: 420_000,
  ...overrides,
});

/** Five paired rounds of one variant, so the sample clears the minRounds note. */
const paired = (variant, baseOverrides = {}, branchOverrides = {}) =>
  Array.from({ length: 5 }, (_, i) => [
    run('base', variant, { round: i + 1, ...baseOverrides }),
    run('branch', variant, { round: i + 1, ...branchOverrides }),
  ]).flat();

test('median and spread are order-independent and robust to one outlier', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  // One doubled sample must not move the median the way a mean would.
  assert.equal(median([100, 100, 100, 100, 200]), 100);
  assert.equal(spreadPct([100, 100, 100, 100, 200]), 100);
  assert.equal(spreadPct([50]), 0);
});

test('pctDelta refuses to divide by a zero baseline', () => {
  assert.equal(pctDelta(50, 100), -50);
  assert.equal(pctDelta(0, 0), null);
});

test('parsePeakRss reads both time(1) dialects and reports absence as null', () => {
  assert.equal(parsePeakRss('        2.55 real\n   305807360  maximum resident set size\n'), 305807360);
  assert.equal(parsePeakRss('\tMaximum resident set size (kbytes): 2048\n'), 2048 * 1024);
  // A summary with no RSS line must not read as a free parse.
  assert.equal(parsePeakRss('command terminated abnormally\n'), null);
});

test('unpaired sides are refused rather than averaged', () => {
  const rows = [run('base', 'rooted'), run('base', 'rooted'), run('branch', 'rooted')];
  assert.throws(() => groupRuns(rows), (e) => e instanceof InvalidRuns && /unpaired/.test(e.message));
  assert.throws(() => groupRuns([run('base', 'rooted')]), /at least one base and one branch/);
  assert.throws(() => groupRuns([run('nope', 'rooted')]), /must be "base" or "branch"/);
  assert.throws(() => groupRuns([run('base', 'rooted', { peakRssBytes: -1 }), run('branch', 'rooted')]), /peakRssBytes/);
  assert.throws(() => groupRuns([run('base', 'rooted', { dataModelDigest: '' }), run('branch', 'rooted')]), /dataModelDigest/);
});

test('a halved peak outside the base spread is a real win, and the table says so', () => {
  const rows = paired('rooted', {}, { peakRssBytes: 1024 * 1024 * 500 });
  const summary = summarize(rows);
  const peak = summary.variants[0].metrics.find((m) => m.key === 'peakRssBytes');
  assert.equal(peak.baseMedian, 1000);
  assert.equal(peak.branchMedian, 500);
  assert.equal(peak.deltaPct, -50);
  assert.equal(peak.real, true);
  assert.equal(peak.direction, 'lower');
  assert.equal(summary.identityBroken, false);
  assert.equal(summary.underSampled, false);
  const text = formatReport(summary).join('\n');
  assert.match(text, /peak RSS \(MiB\)/);
  assert.match(text, /-50\.0%/);
  assert.match(text, /VERDICT: output identical on both sides; real moves/);
  // The reported count is the MODEL's instance count, never the served rows.
  assert.match(text, /reported entity_count 1,000,000 instances/);
  assert.match(text, /data-model parquet 420,000 bytes/);
});

test('a move smaller than the base side\'s own spread is reported as noise, not a win', () => {
  // Base swings 1000 -> 1300 MiB between rounds; a 2% branch "win" is inside that.
  const rows = [];
  const basePeaks = [1000, 1100, 1300, 1050, 1200].map((m) => m * 1024 * 1024);
  for (const [i, peak] of basePeaks.entries()) {
    rows.push(run('base', 'all', { round: i + 1, peakRssBytes: peak }));
    rows.push(run('branch', 'all', { round: i + 1, peakRssBytes: peak * 0.98 }));
  }
  const summary = summarize(rows);
  const peak = summary.variants[0].metrics.find((m) => m.key === 'peakRssBytes');
  assert.ok(peak.deltaPct < 0, 'the median did move down');
  assert.equal(peak.real, false, 'but not past the base side\'s own spread');
  assert.match(formatReport(summary).join('\n'), /within this machine's noise/);
});

test('a digest that differs across sides invalidates the run', () => {
  const summary = summarize(paired('rooted', {}, { dataModelDigest: 'dm-moved' }));
  assert.equal(summary.identityBroken, true);
  const text = formatReport(summary).join('\n');
  assert.match(text, /data-model parquet digest DIFFERS/);
  assert.match(text, /NOT like-for-like/);
});

test('a digest that moves BETWEEN rounds is named as non-determinism, not as a side difference', () => {
  const rows = paired('all');
  rows[2].geometryDigest = 'geo-drifted'; // one base round only
  const summary = summarize(rows);
  assert.equal(summary.unstable, true);
  assert.match(formatReport(summary).join('\n'), /varied BETWEEN ROUNDS/);
});

test('a noisy TOTAL refuses a verdict even when every digest agrees', () => {
  const rows = [];
  for (const [i, total] of [900, 1400, 1000, 1600, 950].entries()) {
    rows.push(run('base', 'all', { round: i + 1, totalMs: total }));
    rows.push(run('branch', 'all', { round: i + 1, totalMs: total }));
  }
  const summary = summarize(rows);
  assert.equal(summary.tooNoisy, true);
  assert.match(formatReport(summary).join('\n'), /too noisy to call/);
});

test('a short run is reported but marked as not acceptance evidence', () => {
  const summary = summarize([run('base', 'rooted'), run('branch', 'rooted')]);
  assert.equal(summary.underSampled, true);
  assert.match(formatReport(summary).join('\n'), /fewer than 5 rounds per side/);
});

test('both variants are summarized separately', () => {
  const summary = summarize([...paired('all'), ...paired('rooted', {}, { peakRssBytes: 1024 * 1024 * 400 })]);
  assert.deepEqual(summary.variants.map((v) => v.variant), ['all', 'rooted']);
  assert.equal(summary.variants[0].metrics.find((m) => m.key === 'peakRssBytes').real, false);
  assert.equal(summary.variants[1].metrics.find((m) => m.key === 'peakRssBytes').real, true);
});

test('an entity_count that moves with the served variant is flagged (#6034)', () => {
  // The header both variants share reports the MODEL's instance count. A side
  // that reports the narrowed row count instead has reintroduced #6034, and
  // the digests alone would not catch it.
  const rows = paired('rooted', {}, { totalEntities: 211_716 });
  const text = formatReport(summarize(rows)).join('\n');
  assert.match(text, /reported entity_count disagrees across runs/);
});
