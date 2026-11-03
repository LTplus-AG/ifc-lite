/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('8413: a change confined to longTaskMs is a column and a real movement', () => {
  const only = (side, v) => rows(side, [v, v, v], { totalMs: 10, longTaskMs: v });
  const report = compare([...only('base', 100), ...only('branch', 160)]);
  assert.equal(column(report, 'longTaskMs').real, true);
  assert.equal(column(report, 'longTaskMs').direction, 'higher');
});

test('7955: native rows from separate invocations pair by pairing id and round, and only by it', async () => {
  const { writeResult } = await import('./retained-qual-lib.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rep-native-'));
  const host = { hostname: 'same-host', machineIdSha256: 'machine-a' };
  // Every invocation is written by writeResult and read back with its own result.json; only the named fields vary.
  const cohort = (name, { pairingId, startedAt }) => [['base', 1, 100], ['branch', 1, 90], ['base', 2, 101], ['branch', 2, 91]].map(([side, round, wallMs]) => {
    const out = join(dir, `${name}-${side}-${round}`);
    writeResult(out, { kind: 'native-retained-memory', startedAt: startedAt(side, round), pairingId: pairingId(side),
      host: { ...host, loadAtStart: { load1: wallMs, load5: round } } }, [{ side, path: 'advanced_model', round, ok: true, wallMs, candidates: 4, published: 3 }]);
    return out;
  });
  try {
    // Distinct invocations (startedAt) under one pairing id: paired by the id.
    const shared = compare(readRows(cohort('shared', { pairingId: () => 'cohort-a', startedAt: (side, round) => `${side}-${round}` })));
    assert.equal(shared.flags.unpaired, false);
    assert.equal(column(shared, 'wallMs').pairedN, 2);
    // Identical startedAt on every row, base and branch under different ids: the id alone keeps them apart.
    const split = compare(readRows(cohort('split', { pairingId: side => `cohort-${side}`, startedAt: () => 'same-start' })));
    assert.equal(split.flags.unpaired, true);
    assert.equal(column(split, 'wallMs').pairedN, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('7955: without a machine id, rows from separate invocations never pair on static host attributes', async () => {
  const { writeResult } = await import('./retained-qual-lib.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rep-nomachine-'));
  try {
    const inputs = [];
    for (const [side, round, wallMs] of [['base', 1, 100], ['branch', 1, 90], ['base', 2, 101], ['branch', 2, 91]]) {
      const out = join(dir, `${side}-${round}`);
      writeResult(out, { kind: 'native-retained-memory', startedAt: `${side}-${round}`, pairingId: 'cohort-a',
        host: { hostname: 'container', cpuModel: 'x', cpuCount: 8, machineIdSha256: null, loadAtStart: { load1: 1, load5: 1 } } },
        [{ side, path: 'advanced_model', round, ok: true, wallMs, candidates: 4, published: 3 }]);
      inputs.push(out);
    }
    const report = compare(readRows(inputs));
    assert.equal(report.flags.unpaired, true);
    assert.ok(report.fixtures.every(f => f.columns.every(c => c.pairedN === 0)));
    // One invocation (both arms, one host record) still pairs without a machine id.
    const host = { hostname: 'container', machineIdSha256: null, loadAtStart: { load1: 1, load5: 1 } };
    const one = [...rows('base', [100, 101]), ...rows('branch', [90, 91])].map(r => ({ ...r, provenance: { host, startedAt: 'one-run' } }));
    assert.equal(compare(one).flags.unpaired, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('7955: separate unpaired invocations on one machine stay separate fixtures, never pooled', () => {
  const host = (load1) => ({ hostname: 'pop', machineIdSha256: 'machine-a', loadAtStart: { load1, load5: 1 } });
  const run = (startedAt, branchMs, load1) => [...rows('base', [100, 101]), ...rows('branch', branchMs)]
    .map(r => ({ ...r, kind: 'viewer', provenance: { kind: 'viewer', host: host(load1), startedAt } }));
  // A/B base X vs branch Y, then base X vs branch Z: two comparisons, not one pooled one.
  const report = compare([...run('run-y', [120, 121], 1), ...run('run-z', [80, 81], 2)]);
  assert.equal(report.fixtures.length, 2);
  assert.equal(report.flags.unpaired, false);
  assert.deepEqual(report.fixtures.map(f => column({ fixtures: [f] }, 'totalMs').branchMedian).sort(), [120.5, 80.5].sort());
  // A single-arm run beside an A/B run does not flip the A/B fixture to unpaired.
  const single = rows('branch', [90, 91]).map(r => ({ ...r, kind: 'viewer', provenance: { kind: 'viewer', host: host(3), startedAt: 'single' } }));
  const mixed = compare([...run('run-y', [120, 121], 1), ...single]);
  assert.equal(mixed.fixtures.length, 2);
  assert.ok(mixed.fixtures.some(f => f.base === 2 && f.branch === 2 && column({ fixtures: [f] }, 'totalMs').pairedN === 2));
});

test('7955: a shared pairing id without any host record never pairs separate invocations', () => {
  const native = (side, round, startedAt) => ({ side, path: 'advanced_model', round, ok: true, wallMs: side === 'base' ? 100 : 90,
    kind: 'native-retained-memory', provenance: { kind: 'native-retained-memory', pairingId: 'cohort-a', startedAt } });
  const report = compare([native('base', 1, 'b1'), native('branch', 1, 'r1'), native('base', 2, 'b2'), native('branch', 2, 'r2')]);
  assert.equal(report.flags.unpaired, true);
  assert.ok(report.fixtures.every(f => f.columns.every(c => c.pairedN === 0)));
});
