#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the anti-vacuity refusals in
 * check-benchmark-regression.js (#3200, finding 8).
 *
 * A floor nobody ever sees fire is the same species of unexamined instrument
 * the issue is about: it can be written wrong, or wired to a count that is
 * never zero, and nothing says so. So every refusal here is driven over a
 * synthetic tree where it MUST fire, and over one where it MUST NOT — the
 * second half is what catches a refusal that fires on everything.
 *
 * The gate derives its root from its own location, so a COPY of the one file
 * into a temp tree is the whole reproduction — no `--root` seam needed, and
 * therefore none added to the gate.
 *
 * Several cases below were defects found in review rather than guesses: the
 * advisory `return` used to skip the harness check whenever a threshold
 * regression fired; failing on plain "no number on one side" would have
 * hard-failed the lane, since two of the four committed baseline entries carry
 * only 2 of the 6 thresholded metrics; and the renamed-fixture refusal only
 * covered the case where EVERY model missed its baseline.
 *
 * Run: node --test scripts/check-benchmark-regression.test.mjs
 * (CI runs `node --test scripts/*.test.mjs` — see .github/workflows/test.yml.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ALL_METRICS = {
  firstBatchWaitMs: 100,
  firstVisibleGeometryMs: 100,
  streamCompleteMs: 100,
  spatialReadyMs: 100,
  metadataCompleteMs: 100,
  totalWallClockMs: 100,
};

function benchTree({ current, baseline, baselineKey = 'x.ifc' }) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'tests', 'benchmark', 'benchmark-results'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'check-benchmark-regression.js'),
    readFileSync(join(HERE, 'check-benchmark-regression.js')),
  );
  writeFileSync(
    join(dir, 'tests', 'benchmark', 'benchmark-results', 'viewer-x.json'),
    JSON.stringify({ file: 'x.ifc', metrics: current }),
  );
  writeFileSync(
    join(dir, 'tests', 'benchmark', 'baseline.json'),
    JSON.stringify({
      [baselineKey]: { timestamp: '2026-01-01', environment: 'github-actions', metrics: baseline },
    }),
  );
  return dir;
}

function runBench(dir, { advisory = true } = {}) {
  const res = spawnSync(
    process.execPath,
    [join(dir, 'scripts', 'check-benchmark-regression.js'), ...(advisory ? ['--advisory'] : [])],
    { encoding: 'utf-8', cwd: dir },
  );
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

test('benchmark: a harness fault is reported even when a REGRESSION exits first', () => {
  // Without --advisory a regression took `process.exit(1)` before the harness
  // faults were printed, so a run with both reported only the SOFTER problem.
  // CI always passes --advisory so the lane never showed it; a local
  // `pnpm benchmark:check` did.
  //
  // Fixture carries both at once: `totalWallClockMs` regresses 100 -> 200, and
  // `firstBatchWaitMs` is in the baseline but absent from the current run,
  // which is a lost metric — the check did not run, not "it is slow".
  const dir = benchTree({
    current: { totalWallClockMs: 200 },
    baseline: { totalWallClockMs: 100, firstBatchWaitMs: 100 },
  });
  try {
    const { code, out } = runBench(dir, { advisory: false });
    assert.equal(code, 1, out);
    assert.match(out, /regression/i, `the regression must still be reported:\n${out}`);
    // The point of the test: the HARDER problem must survive the early exit.
    assert.match(out, /firstBatchWaitMs/, `the lost metric must be named:\n${out}`);
    assert.match(out, /Not softened by --advisory/, `the harness verdict must print:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: a metric absent from BOTH sides is ordinary, not a failure', () => {
  // Two of the four committed baseline entries carry only 2 of the 6 metrics.
  // Failing on plain "unmeasured" would hard-fail the lane the moment either
  // entered VIEWER_BENCHMARK_FILES.
  const partial = { firstBatchWaitMs: 100, totalWallClockMs: 100 };
  const dir = benchTree({ current: partial, baseline: partial });
  try {
    const { code, out } = runBench(dir);
    assert.equal(code, 0, `a partial-but-consistent baseline must pass:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: a metric the BASELINE had and this run LOST fails, even with --advisory', () => {
  const dir = benchTree({
    current: { firstBatchWaitMs: 100, totalWallClockMs: 100 },
    baseline: ALL_METRICS,
  });
  try {
    const { code, out } = runBench(dir);
    assert.equal(code, 1, `a lost metric is a harness fault, not a slow benchmark:\n${out}`);
    assert.match(out, /the BASELINE had/);
    assert.match(out, /Not softened by --advisory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: a threshold regression does NOT suppress the harness check', () => {
  // The bug this pins: the advisory `return` on a regression sat ABOVE the
  // harness check, so the run most likely to have a broken harness was the one
  // that never checked. Thresholds are +50% on a shared runner, so that branch
  // is taken often.
  const dir = benchTree({
    current: { firstBatchWaitMs: 300, totalWallClockMs: 100 },
    baseline: ALL_METRICS,
  });
  try {
    const { code, out } = runBench(dir);
    assert.match(out, /Advisory mode: regressions reported/, 'guard: a regression must be present');
    assert.equal(code, 1, `the harness fault must still fail:\n${out}`);
    assert.match(out, /the BASELINE had/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: a renamed fixture matching NO baseline fails rather than reporting clean', () => {
  const dir = benchTree({
    current: ALL_METRICS,
    baseline: ALL_METRICS,
    baselineKey: 'RENAMED.ifc',
  });
  try {
    const { code, out } = runBench(dir);
    assert.equal(code, 1, `compared nothing, so it has no clean verdict to give:\n${out}`);
    assert.match(out, /NOT ONE had a baseline entry/);
    assert.doesNotMatch(
      out,
      /^No threshold regressions detected\.$/m,
      'the pre-#3200 clean line must not appear when nothing was compared',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: ONE model of two missing its baseline is still not a clean bill of health', () => {
  // The `NOT ONE had a baseline entry` refusal is keyed on a count that only a
  // TOTAL discovery failure drives to zero. `VIEWER_BENCHMARK_FILES` lists two
  // models, so renaming ONE fixture -- the likelier accident -- slipped past it
  // and left the sticky PR comment headed `✅ No threshold regressions
  // detected.` over a model that was never compared at all.
  //
  // Still exit 0: one model WAS compared, so there is a real partial verdict
  // and hard-failing here would red the lane the first time a new model is
  // added before its baseline exists. Only the CLEAN headline is refused.
  const dir = benchTree({ current: ALL_METRICS, baseline: ALL_METRICS });
  const md = join(dir, 'report.md');
  try {
    writeFileSync(
      join(dir, 'tests', 'benchmark', 'benchmark-results', 'viewer-y.json'),
      JSON.stringify({ file: 'RENAMED.ifc', metrics: ALL_METRICS }),
    );
    const res = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'check-benchmark-regression.js'), '--advisory', '--markdown', md],
      { encoding: 'utf-8', cwd: dir },
    );
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.equal(res.status, 0, out);
    const report = readFileSync(md, 'utf-8');
    assert.doesNotMatch(
      report,
      /✅ No threshold regressions detected/,
      'the PR-comment headline claimed a clean run over a model it never compared',
    );
    assert.match(report, /1 of 2 model\(s\) had NO/);
    assert.doesNotMatch(out, /^No threshold regressions detected\.$/m);
    assert.match(out, /never compared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: a fully-compared healthy run still gets its clean headline', () => {
  // The other direction: the branch added above must not fire on everything.
  const dir = benchTree({ current: ALL_METRICS, baseline: ALL_METRICS });
  const md = join(dir, 'report.md');
  try {
    const res = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'check-benchmark-regression.js'), '--advisory', '--markdown', md],
      { encoding: 'utf-8', cwd: dir },
    );
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.equal(res.status, 0, out);
    assert.match(readFileSync(md, 'utf-8'), /✅ No threshold regressions detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: the markdown report is written BEFORE the gate exits', () => {
  // On a harness fault the report IS the diagnosis. A gate that dies before
  // writing it throws away exactly what someone needs to fix the thing.
  const dir = benchTree({
    current: { firstBatchWaitMs: 100, totalWallClockMs: 100 },
    baseline: ALL_METRICS,
  });
  const md = join(dir, 'report.md');
  try {
    const res = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'check-benchmark-regression.js'), '--advisory', '--markdown', md],
      { encoding: 'utf-8', cwd: dir },
    );
    assert.equal(res.status, 1, 'guard: this input must fail, or the test proves nothing');
    assert.ok(existsSync(md), 'the report was not written before the exit');
    assert.match(readFileSync(md, 'utf-8'), /viewer-benchmark-report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark: the MARKDOWN refuses a verdict too, not just the console', () => {
  // The markdown is the primary artefact -- benchmark.yml publishes it to the
  // step summary and the sticky PR comment, and that is what a human reads.
  // Refusing on the console alone left the PR comment saying
  // `✅ No threshold regressions detected.` on a renamed fixture, which with no
  // rows is trivially true and entirely misleading: the same mixed signal, in
  // the louder channel.
  const dir = benchTree({ current: ALL_METRICS, baseline: ALL_METRICS, baselineKey: 'RENAMED.ifc' });
  const md = join(dir, 'report.md');
  try {
    const res = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'check-benchmark-regression.js'), '--advisory', '--markdown', md],
      { encoding: 'utf-8', cwd: dir },
    );
    assert.equal(res.status, 1, 'guard: this input must be a harness fault');
    const report = readFileSync(md, 'utf-8');
    assert.match(report, /No verdict: the benchmark did not run/);
    assert.doesNotMatch(
      report,
      /✅ No threshold regressions detected/,
      'the PR comment must not claim a clean run the console just refused',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
