/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Retired-instruction counting for browser opens: the wrapper's samples are interpolated at the open's window,
// per PMU and summed; uncovered windows and unavailable counters are reported, never read as zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTR_WRAPPER, instructionsIn, parseInstrSamples } from './load-scoreboard-instr.mjs';

const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const samples = ndjson([
  { t: 1000, c: { cpu_core: 0, cpu_atom: 0 }, e: 0, r: { cpu_core: 0, cpu_atom: 0 } },
  { t: 1010, c: { cpu_core: 100, cpu_atom: 50 }, e: 10e6, r: { cpu_core: 6e6, cpu_atom: 4e6 } },
  { t: 1020, c: { cpu_core: 300, cpu_atom: 150 }, e: 20e6, r: { cpu_core: 12e6, cpu_atom: 8e6 } },
  { t: 1030, c: { cpu_core: 300, cpu_atom: 450 }, e: 30e6, r: { cpu_core: 14e6, cpu_atom: 16e6 } },
  { t: 1100, c: { cpu_core: 999, cpu_atom: 999 }, e: 40e6, r: { cpu_core: 20e6, cpu_atom: 20e6 }, final: true },
]);

test('instructions in a window: interpolated at both edges, per PMU and summed, with the interpolation span', () => {
  const r = instructionsIn(parseInstrSamples(samples), 1005, 1025);
  assert.deepEqual(r.pmu, { cpu_core: 250, cpu_atom: 275 }); // core 50 -> 300, atom 25 -> 300
  assert.equal(r.total, 525);
  assert.equal(r.edgeGapMs, 5);
});

test('the final totals line is not a sample; an uncovered window or a wrapper that could not count is unavailable', () => {
  const p = parseInstrSamples(samples);
  assert.equal(p.samples.length, 4);
  assert.match(instructionsIn(p, 1025, 1050).unavailable, /not covered/);
  assert.equal(instructionsIn(p, 1025, 1050).total, null);
  const u = parseInstrSamples(ndjson([{ unavailable: 'perf_event_open failed (perf_event_paranoid=3)' }]));
  assert.deepEqual(instructionsIn(u, 1, 2), { total: null, pmu: null, unavailable: 'perf_event_open failed (perf_event_paranoid=3)' });
  assert.match(parseInstrSamples('').unavailable, /no counter output/);
});

test('the wrapper runs the real program with its arguments and exit status, and writes samples or says why it cannot', { skip: process.platform !== 'linux' }, () => {
  const out = join(mkdtempSync(join(tmpdir(), 'instr-')), 'i.ndjson');
  const run = spawnSync('python3', [INSTR_WRAPPER, '-c', 'i=0\nfor _ in range(3000000): i+=1\nraise SystemExit(3)'],
    { env: { ...process.env, LOAD_SCOREBOARD_INSTR_CHROME: spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim(), LOAD_SCOREBOARD_INSTR_OUT: out }, encoding: 'utf8' });
  assert.equal(run.status, 3, run.stderr);
  const p = parseInstrSamples(readFileSync(out, 'utf8'));
  if (p.unavailable) assert.match(p.unavailable, /perf_event|platform|samples/);
  else {
    const last = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(last.final, true);
    assert.ok(Object.values(last.c).reduce((a, b) => a + b, 0) > 3e6, 'a 3M-iteration loop retires more than 3M instructions');
  }
});

test('an unavailable counter (e.g. macOS) is carried on every lane and shown in the report with its reason', async () => {
  const { laneInstructions } = await import('./load-scoreboard-instr.mjs');
  const { cpuTimeSummary, cpuTimeSection } = await import('./load-scoreboard-report-cpu.mjs');
  const lanes = laneInstructions({ 'browser-cold': { ok: true }, 'browser-warm': { ok: true } }, { unavailable: 'instruction counting supports x86 Linux PMUs cpu / cpu_core+cpu_atom; this host: darwin' });
  assert.deepEqual(Object.values(lanes).map((l) => l.instructions.unavailable), ['instruction counting supports x86 Linux PMUs cpu / cpu_core+cpu_atom; this host: darwin', 'instruction counting supports x86 Linux PMUs cpu / cpu_core+cpu_atom; this host: darwin']);
  const rows = [0, 1].flatMap((n) => ['base', 'branch'].map((side) => ({ fixture: 'FZK', lane: 'browser-cold', side, round: n, interactiveMs: 500, ...lanes['browser-cold'] })));
  const line = cpuTimeSection(rows, { cpuTime: cpuTimeSummary({ kind: 'aa', lanes: ['browser-cold'] }, rows) }).find((l) => l.startsWith('| FZK |'));
  assert.match(line, /instructions unavailable 4: instruction counting supports x86 Linux PMUs cpu \/ cpu_core\+cpu_atom; this host: darwin/);
  // A lane without a measured window (its open failed) says so instead of reading zero.
  const p = parseInstrSamples(samples);
  const two = laneInstructions({ a: {}, b: {} }, { parsed: p, windows: [{ lane: 'a', window: [1005, 1025] }] });
  assert.equal(two.a.instructions.total, 525);
  assert.match(two.b.instructions.unavailable, /no measured window/);
});

test('a core PMU that exists but whose instructions event cannot be resolved makes the whole count unavailable', { skip: process.platform !== 'linux' }, () => {
  // Fake PMU tree: cpu_core complete, cpu_atom present without events/instructions.
  const root = mkdtempSync(join(tmpdir(), 'pmu-'));
  mkdirSync(join(root, 'cpu_core', 'events'), { recursive: true });
  writeFileSync(join(root, 'cpu_core', 'type'), '4\n');
  writeFileSync(join(root, 'cpu_core', 'events', 'instructions'), 'event=0xc0\n');
  mkdirSync(join(root, 'cpu_atom'), { recursive: true });
  writeFileSync(join(root, 'cpu_atom', 'type'), '10\n');
  const out = join(root, 'i.ndjson');
  const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const run = spawnSync('python3', [INSTR_WRAPPER, '-c', 'raise SystemExit(0)'],
    { env: { ...process.env, LOAD_SCOREBOARD_INSTR_CHROME: python, LOAD_SCOREBOARD_INSTR_OUT: out, LOAD_SCOREBOARD_INSTR_PMU_ROOT: root }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const first = JSON.parse(readFileSync(out, 'utf8').split('\n')[0]);
  assert.match(first.unavailable ?? '', /cpu_atom: instructions event cannot be resolved/);
});

test('counter samples whose PMU sets differ are unavailable, never a partial sum', () => {
  const rows = [{ t: 1, c: { cpu_core: 0, cpu_atom: 0 } }, { t: 2, c: { cpu_core: 10 } }, { t: 3, c: { cpu_core: 20, cpu_atom: 5 } }];
  assert.match(parseInstrSamples(rows.map((r) => JSON.stringify(r)).join('\n')).unavailable, /differing/);
});

test('a periodic read includes LIVE inherited children (kernel __perf_event_read_value walks child_list), not only exited ones', { skip: process.platform !== 'linux' }, () => {
  // The wrapped "browser" forks a child that spins a fixed loop, stamps the time, then sleeps 1 s WITHOUT exiting;
  // the parent only waits. A sample taken while the child still sleeps must already hold (nearly) the child's whole count.
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  const out = join(dir, 'i.ndjson'), stamps = join(dir, 'stamps.json');
  const script = [
    'import os, time, json, sys',
    `stamps = ${JSON.stringify(stamps)}`,
    'time.sleep(0.2)', 'fork_at = time.time() * 1000',
    'pid = os.fork()',
    'if pid == 0:',
    '    i = 0',
    '    for _ in range(3000000): i += 1',
    '    json.dump({"fork": fork_at, "done": time.time() * 1000}, open(stamps, "w"))',
    '    time.sleep(1.0)', '    os._exit(0)',
    'os.waitpid(pid, 0)',
  ].join('\n');
  const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const run = spawnSync('python3', [INSTR_WRAPPER, '-c', script], { env: { ...process.env, LOAD_SCOREBOARD_INSTR_CHROME: python, LOAD_SCOREBOARD_INSTR_OUT: out }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (lines[0].unavailable) return; // counting not permitted on this host (e.g. perf_event_paranoid on CI)
  const { fork, done } = JSON.parse(readFileSync(stamps, 'utf8'));
  const sum = (r) => Object.values(r.c).reduce((a, b) => a + b, 0);
  const samples = lines.filter((r) => !r.final);
  const before = samples.filter((r) => r.t <= fork).at(-1);
  const live = samples.find((r) => r.t >= done + 100 && r.t <= done + 800); // child alive and sleeping
  const final = lines.find((r) => r.final);
  assert.ok(before && live && final, 'samples around the fork, during the child\'s sleep, and the final totals');
  const childTotal = sum(final) - sum(before);
  assert.ok(childTotal > 3e6, `the child's loop retired instructions (${childTotal})`);
  assert.ok(sum(live) - sum(before) >= 0.9 * childTotal, `live read ${sum(live) - sum(before)} vs total after exit ${childTotal}`);
});

test('lifetime PMU coverage decides: 0.99996 is accepted and reported unrounded, 0.9998 and a multiplexed run are rejected', () => {
  const run = (cov) => {
    const rows = [0, 1, 2, 3].map((i) => ({ t: 1000 + i * 10, c: { cpu_core: i * 100, cpu_atom: i * 50 }, e: i * 10e6, r: { cpu_core: i * 6e6, cpu_atom: i * 4e6 } }));
    rows.push({ t: 1100, c: { cpu_core: 400, cpu_atom: 200 }, e: 1e9, r: { cpu_core: 0.6e9 * cov, cpu_atom: 0.4e9 * cov }, final: true });
    return parseInstrSamples(rows.map((x) => JSON.stringify(x)).join('\n'));
  };
  const ok = run(0.99996);
  assert.equal(ok.lifetimeCoverage, 0.99996);
  const r = instructionsIn(ok, 1005, 1025);
  assert.equal(r.total, 300); // 1005..1025 interpolated: cpu_core 50 -> 250, cpu_atom 25 -> 125
  assert.equal(r.lifetimeCoverage, 0.99996);
  assert.match(run(0.9998).unavailable, /PMU multiplexed: counters ran 99.9800% of their enabled time over the sample/);
  assert.match(run(0.5).unavailable, /PMU multiplexed/);
  // No final totals: lifetime coverage unknown; samples without scheduling fields: unavailable.
  const noFinal = [0, 1, 2].map((i) => JSON.stringify({ t: i, c: { cpu: i }, e: i, r: { cpu: i } })).join('\n');
  assert.match(parseInstrSamples(noFinal).unavailable, /no final counter totals/);
});

test('a very long sample history does not overflow the argument limit', () => {
  const n = 250000, rows = [];
  for (let i = 0; i < n; i++) rows.push(JSON.stringify({ t: i, c: { cpu: i * 10 }, e: i * 1e6, r: { cpu: i * 1e6 } }));
  rows.push(JSON.stringify({ t: n, c: { cpu: n * 10 }, e: n * 1e6, r: { cpu: n * 1e6 }, final: true }));
  const r = instructionsIn(parseInstrSamples(rows.join('\n')), 1000.5, 200000.5);
  assert.equal(r.total, 1990000);
});

test('a window where the counters never ran (no enabled time) is unavailable, never a measured zero', () => {
  // Lifetime coverage fine, but no enabled time between the samples bracketing this window.
  const rows = [{ t: 1000, c: { cpu: 0 }, e: 0, r: { cpu: 0 } }, { t: 1010, c: { cpu: 0 }, e: 0, r: { cpu: 0 } }, { t: 1020, c: { cpu: 0 }, e: 0, r: { cpu: 0 } },
    { t: 1030, c: { cpu: 500 }, e: 5e6, r: { cpu: 5e6 } }, { t: 1100, c: { cpu: 500 }, e: 5e6, r: { cpu: 5e6 }, final: true }];
  const r = instructionsIn(parseInstrSamples(rows.map((x) => JSON.stringify(x)).join('\n')), 1005, 1015);
  assert.deepEqual([r.total, r.unavailable], [null, 'counters not running in this window (no enabled time)']);
  // A run whose counters never ran at all.
  const never = rows.map((x) => ({ ...x, e: 0, r: { cpu: 0 }, c: { cpu: 0 } }));
  assert.equal(parseInstrSamples(never.map((x) => JSON.stringify(x)).join('\n')).unavailable, 'counters never ran (no enabled time)');
});

test('browserSample puts an instruction figure or its reason on every lane when counting is requested', { skip: process.platform !== 'linux' }, async () => {
  const { browserSample } = await import('./load-scoreboard-browser.mjs');
  const { fakeBrowserSample } = await import('./load-scoreboard-fake-browser.mjs');
  // The fake never runs the wrapper, so there is no counter output: the lane must carry that reason.
  const { result } = await fakeBrowserSample(browserSample, { instructions: true });
  assert.equal(result.lanes['browser-cold'].instructions.unavailable, 'no counter output (wrapper did not run)');
});

test('a host with only a non-x86 PMU (aarch64 armv8_pmuv3_0) reports the supported PMUs and what it found', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pmu-arm-'));
  mkdirSync(join(root, 'armv8_pmuv3_0', 'events'), { recursive: true });
  writeFileSync(join(root, 'armv8_pmuv3_0', 'type'), '8\n');
  mkdirSync(join(root, 'software'), { recursive: true });
  const out = join(root, 'i.ndjson');
  const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const run = spawnSync('python3', [INSTR_WRAPPER, '-c', 'raise SystemExit(0)'],
    { env: { ...process.env, LOAD_SCOREBOARD_INSTR_CHROME: python, LOAD_SCOREBOARD_INSTR_OUT: out, LOAD_SCOREBOARD_INSTR_PMU_ROOT: root }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(out, 'utf8').split('\n')[0]).unavailable,
    'instruction counting supports x86 Linux PMUs cpu / cpu_core+cpu_atom; found: armv8_pmuv3_0, software');
});
