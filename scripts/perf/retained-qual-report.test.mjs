/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, format, readRows } from './retained-qual-report.mjs';

const rows = (side, values, over = {}) => values.map((v, i) => ({ side, path: '/m/a.ifc', round: i + 1, ok: true, totalMs: v, candidates: 10, published: 7, ...over }));
const column = (report, name) => report.fixtures[0].columns.find(c => c.column === name);

test('a movement beyond the base spread and the floor is flagged, within it is not', () => {
  const moved = compare([...rows('base', [100, 101, 99]), ...rows('branch', [120, 121, 119])]);
  assert.equal(column(moved, 'totalMs').real, true);
  assert.equal(column(moved, 'totalMs').direction, 'higher');
  const quiet = compare([...rows('base', [100, 110, 90]), ...rows('branch', [101, 111, 91])]);
  assert.equal(column(quiet, 'totalMs').real, false, 'inside the base spread');
  const tiny = compare([...rows('base', [0.2, 0.2, 0.2]), ...rows('branch', [0.6, 0.6, 0.6])]);
  assert.equal(column(tiny, 'totalMs').real, false, 'below the 1 ms floor');
});

test('count drift invalidates the comparison; unpaired and too-noisy are named', () => {
  const drift = compare([...rows('base', [100, 100]), ...rows('branch', [90, 90], { published: 6 })]);
  assert.equal(drift.flags.countDrift, true);
  assert.match(format(drift), /NOT like-for-like/);
  assert.equal(compare([...rows('base', [100, 100]), ...rows('branch', [90])]).flags.unpaired, true);
  assert.equal(compare([...rows('base', [100, 150, 80]), ...rows('branch', [100, 100, 100])]).flags.tooNoisy, true);
});

test('failed rows are listed and excluded, never averaged in', () => {
  const report = compare([...rows('base', [100, 100]), ...rows('branch', [100, 100]), { side: 'branch', path: '/m/a.ifc', round: 3, ok: false, error: 'exact load', totalMs: 1 }]);
  assert.equal(report.failures.length, 1);
  assert.equal(column(report, 'totalMs').branchMedian, 100);
  assert.match(format(report), /FAILED sample.*excluded/);
});

test('a zero baseline that rises blocks; the report never prints a no-regression verdict', () => {
  const zero = compare([...rows('base', [0, 0], { settledFrameMs: 0 }), ...rows('branch', [5, 5], { settledFrameMs: 5 })]);
  assert.equal(zero.flags.zeroBaselineIncrease, true);
  const text = format(compare([...rows('base', [100, 101]), ...rows('branch', [100, 101])]));
  assert.match(text, /REPORT-ONLY/);
  assert.doesNotMatch(text, /no regression|within noise|✅/i);
});

test('CLI: unreadable input exits 2; a good pair exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  try {
    const good = join(dir, 'runs.jsonl');
    writeFileSync(good, [...rows('base', [100, 101]), ...rows('branch', [100, 101])].map(r => JSON.stringify(r)).join('\n'));
    const run = args => spawnSync(process.execPath, [new URL('./retained-qual-report.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
    assert.equal(run([good]).status, 0);
    assert.equal(run([dir]).status, 0, 'a result directory reads its runs.jsonl');
    writeFileSync(join(dir, 'bad.jsonl'), '{not json');
    assert.equal(run([join(dir, 'bad.jsonl')]).status, 2);
    assert.equal(run([]).status, 2);
    assert.throws(() => readRows([join(dir, 'missing.jsonl')]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('8413: an aborted cohort reports expected versus observed and exits nonzero', async () => {
  const { writeResult } = await import('./retained-qual-lib.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rep-incomplete-'));
  try {
    const sample = { side: 'branch', path: '/m/a.ifc', round: 1, ok: false, cleanupFailed: true, error: 'cleanup failed' };
    writeResult(dir, { kind: 'viewer', rounds: 3, arms: [{ side: 'branch' }], fixtures: [{ path: sample.path }], startedAt: 'aborted-run' }, [sample]);
    // Both directory input and the portable JSONL carry cohort completeness.
    for (const input of [dir, join(dir, 'runs.jsonl')]) {
      if (input !== dir) rmSync(join(dir, 'result.json'));
      const report = compare(readRows([input]));
      assert.equal(report.flags.incompleteCohort, true);
      assert.match(format(report), /expected 3, got 1/);
      const cli = spawnSync(process.execPath, [new URL('./retained-qual-report.mjs', import.meta.url).pathname, input], { encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.match(cli.stdout, /expected 3, got 1/);
      assert.doesNotMatch(cli.stdout, /NOTE: numbers only/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('8413: a complete one-arm cohort remains a valid report-only observation', async () => {
  const { writeResult } = await import('./retained-qual-lib.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rep-complete-'));
  try {
    const sample = { side: 'branch', path: '/m/a.ifc', round: 1, ok: true, totalMs: 12 };
    writeResult(dir, { kind: 'cli-retained-export', rounds: 1, arms: [{ side: 'branch' }], fixtures: [{ path: sample.path }] }, [sample]);
    assert.equal(compare(readRows([dir])).flags.incompleteCohort, false);
    const cli = spawnSync(process.execPath, [new URL('./retained-qual-report.mjs', import.meta.url).pathname, dir], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
