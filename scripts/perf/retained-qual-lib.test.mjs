/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare } from './retained-qual-report.mjs';
import { exclusivity, hostIdentity, median, parseArgs, parseArms, pinFor, roundSides, spreadPct, summarizeRows, unreleasedQuietWindows } from './retained-qual-lib.mjs';

test('statistics are the ab-report.mjs definitions (median, spread percent of the median)', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(spreadPct([90, 100, 110]), 20);
  assert.equal(spreadPct([5]), 0);
  assert.equal(spreadPct([0, 0, 0]), 0);
});

test('the reporter classifies exactly as scripts/perf/ab-report.mjs does on the same rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abp-'));
  const scenarios = { moved: [[100, 101, 99], [120, 121, 119]], quiet: [[100, 110, 90], [101, 111, 91]], subMs: [[0.2, 0.2, 0.2], [0.6, 0.6, 0.6]],
    noisy: [[100, 150, 80], [100, 100, 100]], zero: [[0, 0, 0], [5, 5, 5]], faster: [[200, 201, 199], [150, 151, 149]] };
  try {
    for (const [name, [base, branch]] of Object.entries(scenarios)) {
      const rows = [...base.map(v => ['base', v]), ...branch.map(v => ['branch', v])].map(([side, v]) => ({ side, path: '/m/a.ifc', ok: true,
        parseMs: v, geometryMs: v, totalMs: v, meshes: 1, vertices: 1, triangles: 1 }));
      const jsonl = join(dir, `${name}.jsonl`), out = join(dir, `${name}.json`);
      writeFileSync(jsonl, rows.map(r => JSON.stringify(r)).join('\n'));
      const ab = spawnSync(process.execPath, [new URL('./ab-report.mjs', import.meta.url).pathname, jsonl, '--json', out], { encoding: 'utf8' });
      assert.equal(ab.status, 0, ab.stderr);
      const expected = JSON.parse(readFileSync(out, 'utf8')).fixtures[0].phases.find(p => p.phase === 'TOTAL');
      const mine = compare(rows).fixtures[0].columns.find(c => c.column === 'totalMs');
      assert.equal(mine.real, expected.real, `${name}: real`);
      assert.equal(mine.direction === 'lower' ? 'faster' : mine.direction === 'higher' ? 'slower' : mine.direction, expected.direction ?? null, `${name}: direction`);
      assert.equal(mine.noisePct, expected.noisePct, `${name}: noise`);
      assert.equal(mine.deltaPct, expected.deltaPct, `${name}: delta`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseArgs accepts values, repeats, flags and a command after --, and rejects unknown options', () => {
  const { options, rest } = parseArgs(['--out', 'o', '--fixture', 'a', '--fixture', 'b', '--headed', '--', 'cmd', '--worker', 'w'],
    { values: ['out'], repeated: ['fixture'], flags: ['headed'] });
  assert.deepEqual(options, { fixture: ['a', 'b'], out: 'o', headed: true });
  assert.deepEqual(rest, ['cmd', '--worker', 'w']);
  assert.throws(() => parseArgs(['--nope'], { values: [] }), /Unknown option/);
  assert.throws(() => parseArgs(['--out'], { values: ['out'] }), /requires a value/);
  assert.throws(() => parseArgs(['--out', '--x'], { values: ['out'] }), /requires a value/);
});

test('parseArms: one arm observes, a base+branch pair is an A/B, anything else is refused', () => {
  assert.deepEqual(parseArms(['branch:/c:/e']), [{ side: 'branch', checkout: '/c', engine: '/e' }]);
  assert.equal(parseArms(['base:/c1:/e1', 'branch:/c2:/e2']).length, 2);
  assert.throws(() => parseArms([]), /exactly one base and one branch/);
  assert.throws(() => parseArms(['branch:/c:/e', 'branch:/d:/f']), /exactly one base and one branch/);
  assert.throws(() => parseArms(['branch:rel:/e']), /--arm expects/);
  assert.throws(() => parseArms(['main:/c:/e']), /--arm expects/);
});

test('round order is balanced and seed-replayable for a pair, trivial for one arm', async () => {
  const arms = [{ side: 'base' }, { side: 'branch' }];
  const order = await roundSides(arms, 7, 11);
  assert.deepEqual(order, await roundSides(arms, 7, 11));
  assert.equal(order.filter(([first]) => first === 'base').length, 4);
  assert.equal(order.filter(([first]) => first === 'branch').length, 3);
  assert.deepEqual(await roundSides([{ side: 'branch' }], 3), [['branch'], ['branch'], ['branch']]);
});

test('summaries use only OK rows and keep sides apart', () => {
  const rows = [{ side: 'base', path: 'm', ok: true, totalMs: 10 }, { side: 'base', path: 'm', ok: true, totalMs: 20 },
    { side: 'base', path: 'm', ok: false, totalMs: 999 }, { side: 'branch', path: 'm', ok: true, totalMs: 5 }];
  const out = summarizeRows(rows, ['totalMs']);
  assert.equal(out['base/m'].samples, 2);
  assert.equal(out['base/m'].columns.totalMs.median, 15);
  assert.equal(out['branch/m'].columns.totalMs.n, 1);
});

test('exclusivity comes only from a benchmark admission or the submitter, and a contradiction is refused', () => {
  assert.equal(exclusivity({}, {}).exclusive, false);
  assert.match(exclusivity({}, {}).note, /non-exclusive/);
  assert.deepEqual(exclusivity({}, { IFC_WORKER_KIND: 'ordinary', IFC_WORKER_JOB_ID: 'j1' }), { exclusive: false, workerKind: 'ordinary', jobId: 'j1', note: exclusivity({}, {}).note });
  const declared = exclusivity({ 'exclusive-receipt': 'abc' }, {});
  assert.deepEqual([declared.exclusive, declared.verified, declared.receipt], [true, false, 'abc']);
  const admitted = exclusivity({}, { IFC_WORKER_KIND: 'benchmark', IFC_WORKER_JOB_ID: 'j2' });
  assert.deepEqual([admitted.exclusive, admitted.receipt, admitted.source], [true, 'j2', 'IFC_WORKER_KIND=benchmark']);
  assert.throws(() => exclusivity({ 'exclusive-receipt': 'x' }, { IFC_WORKER_KIND: 'ordinary' }), /contradicts/);
});

test('unreleased quiet windows block; released ones do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qw-'));
  try {
    assert.deepEqual(unreleasedQuietWindows(dir), []);
    writeFileSync(join(dir, 'pop-quiet-window-a.json'), JSON.stringify({ released: true }));
    writeFileSync(join(dir, 'pop-quiet-window-b.json'), JSON.stringify({ status: 'released' }));
    assert.deepEqual(unreleasedQuietWindows(dir), []);
    writeFileSync(join(dir, 'pop-quiet-window-c.json'), JSON.stringify({ status: 'held' }));
    assert.equal(unreleasedQuietWindows(dir).length, 1);
    assert.deepEqual(unreleasedQuietWindows(join(dir, 'absent')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host identity names the machine without leaking its raw id', () => {
  const host = hostIdentity();
  assert.ok(host.hostname && host.cpuCount > 0 && host.node.startsWith('v'));
  assert.ok(host.machineIdSha256 === null || /^[a-f0-9]{64}$/.test(host.machineIdSha256));
});

test('pins are flat, or per side when the arms publish different counts', () => {
  const pin = { candidates: 4, published: 3 };
  assert.deepEqual(pinFor({ 'a.ifc': pin }, 'base', 'a.ifc'), pin);
  assert.equal(pinFor(undefined, 'base', 'a.ifc'), undefined);
  const sided = { base: { 'a.ifc': pin }, branch: { 'a.ifc': { candidates: 4, published: 4 } } };
  assert.equal(pinFor(sided, 'base', 'a.ifc').published, 3);
  assert.equal(pinFor(sided, 'branch', 'a.ifc').published, 4);
  assert.equal(pinFor(sided, 'branch', 'missing.ifc'), undefined, 'a per-side file never falls back to another side');
});
