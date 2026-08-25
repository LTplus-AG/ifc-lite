#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The floors added for #3200, exercised in BOTH directions.
 *
 * #3200 catalogued ten gates that report success over a region they never
 * examined. The fix is a floor in each. A floor nobody ever sees fire is the
 * same species of unexamined instrument: it can be written wrong, or wired to a
 * count that is never zero, and nothing says so. So each floor here is driven
 * over a synthetic tree where it MUST fire, and over a tree where it MUST NOT —
 * the second half is the one that gets skipped, and it is what catches a floor
 * that fires on everything.
 *
 * Run: node --test scripts/check-vacuity-floors.test.mjs
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

function run(script, args) {
  const res = spawnSync(process.execPath, [join(HERE, script), ...args], {
    encoding: 'utf-8',
    cwd: join(HERE, '..'),
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** A tree with `packages/<n>` published packages, each with a README. */
function tree(published, { withReadme = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vacuity-'));
  mkdirSync(join(dir, 'packages'), { recursive: true });
  for (let i = 0; i < published; i++) {
    const p = join(dir, 'packages', `p${i}`);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: `@x/p${i}`, version: '1.0.0' }));
    if (withReadme) writeFileSync(join(p, 'README.md'), `# p${i}\n`);
  }
  return dir;
}

test('check-package-readmes: an empty packages/ is a FAILURE, not "all 0 have a README"', () => {
  const dir = tree(0);
  try {
    const { code, out } = run('docs/check-package-readmes.mjs', ['--root', dir]);
    assert.equal(code, 1, `expected a refusal, got ${code}:\n${out}`);
    assert.match(out, /only 0 published package\(s\) reached the README check/);
    // The remedy must name the constant. A message that says only "the SCAN is
    // wrong" is actively misleading to someone who really did retire packages.
    assert.match(out, /lower CHECKED_FLOOR in this file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-package-readmes: a healthy tree still PASSES — the floor is not fire-on-everything', () => {
  const dir = tree(30);
  try {
    const { code, out } = run('docs/check-package-readmes.mjs', ['--root', dir]);
    assert.equal(code, 0, `expected a clean pass, got ${code}:\n${out}`);
    assert.match(out, /All 30 published packages/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-package-readmes: a REAL missing README still fails, above the floor', () => {
  // The floor must not have swallowed the gate's actual job. 30 packages clears
  // CHECKED_FLOOR, so the only thing that can fail here is the README check.
  const dir = tree(30);
  try {
    mkdirSync(join(dir, 'packages', 'bare'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'bare', 'package.json'),
      JSON.stringify({ name: '@x/bare', version: '1.0.0' }),
    );
    const { code, out } = run('docs/check-package-readmes.mjs', ['--root', dir]);
    assert.equal(code, 1, `expected a README failure, got ${code}:\n${out}`);
    assert.match(out, /@x\/bare/);
    assert.doesNotMatch(out, /expected at least/, 'failed on the floor, not on the README');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-npm-publish: all-private is a REFUSAL, not "no publishable packages found"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vacuity-npm-'));
  try {
    mkdirSync(join(dir, 'packages', 'priv'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'priv', 'package.json'),
      JSON.stringify({ name: '@x/priv', version: '1.0.0', private: true }),
    );
    const { code, out } = run('verify-npm-publish.js', ['--root', dir]);
    // Exit 2 is this gate's existing "verified nothing" code, not a new one.
    assert.equal(code, 2, `expected a refusal, got ${code}:\n${out}`);
    assert.match(out, /only 0 publishable package\(s\) found among/);
    assert.match(out, /lower PUBLISHABLE_FLOOR in this file/);
    assert.doesNotMatch(
      out,
      /No publishable packages found/,
      'the pre-#3200 success line must be gone, not merely accompanied',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-npm-publish: an unreadable parent is fatal, not a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vacuity-npm2-'));
  try {
    mkdirSync(join(dir, 'packages'), { recursive: true });
    // A `packages` FILE where a directory is expected: readdirSync raises
    // ENOTDIR, which is neither ENOENT nor readable. The pre-#3200 code
    // console.warn'd and carried on with a silently smaller set.
    rmSync(join(dir, 'packages'), { recursive: true, force: true });
    writeFileSync(join(dir, 'packages'), 'not a directory');
    const { code, out } = run('verify-npm-publish.js', ['--root', dir]);
    assert.equal(code, 2, `expected a refusal, got ${code}:\n${out}`);
    assert.match(out, /could not list .*\/packages \(/);
    assert.match(out, /an unreadable workspace parent is not an empty one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// check-benchmark-regression.js
//
// It derives its root from its own location, so a COPY in a temp tree is the
// whole reproduction — no `--root` seam needed. Three of the four cases below
// were defects found in review rather than guesses: the advisory `return` used
// to skip the harness check whenever a threshold regression fired, and failing
// on plain "no number on one side" would have hard-failed the lane, since two
// of the four committed baseline entries carry only 2 of the 6 metrics.

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

function runBench(dir) {
  const res = spawnSync(
    process.execPath,
    [join(dir, 'scripts', 'check-benchmark-regression.js'), '--advisory'],
    { encoding: 'utf-8', cwd: dir },
  );
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

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
