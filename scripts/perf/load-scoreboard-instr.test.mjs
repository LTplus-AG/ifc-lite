/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Retired-instruction counting for browser opens: the wrapper's samples are interpolated at the open's window,
// per PMU and summed; uncovered windows and unavailable counters are reported, never read as zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTR_WRAPPER, instructionsIn, parseInstrSamples } from './load-scoreboard-instr.mjs';

const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const samples = ndjson([
  { t: 1000, c: { cpu_core: 0, cpu_atom: 0 } }, { t: 1010, c: { cpu_core: 100, cpu_atom: 50 } },
  { t: 1020, c: { cpu_core: 300, cpu_atom: 150 } }, { t: 1030, c: { cpu_core: 300, cpu_atom: 450 } },
  { t: 1100, c: { cpu_core: 999, cpu_atom: 999 }, final: true },
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
  const lanes = laneInstructions({ 'browser-cold': { ok: true }, 'browser-warm': { ok: true } }, { unavailable: 'instruction counting is Linux only (darwin)' });
  assert.deepEqual(Object.values(lanes).map((l) => l.instructions.unavailable), ['instruction counting is Linux only (darwin)', 'instruction counting is Linux only (darwin)']);
  const rows = [0, 1].flatMap((n) => ['base', 'branch'].map((side) => ({ fixture: 'FZK', lane: 'browser-cold', side, round: n, interactiveMs: 500, ...lanes['browser-cold'] })));
  const line = cpuTimeSection(rows, { cpuTime: cpuTimeSummary({ kind: 'aa', lanes: ['browser-cold'] }, rows) }).find((l) => l.startsWith('| FZK |'));
  assert.match(line, /instructions unavailable 4: instruction counting is Linux only \(darwin\)/);
  // A lane without a measured window (its open failed) says so instead of reading zero.
  const p = parseInstrSamples(samples);
  const two = laneInstructions({ a: {}, b: {} }, { parsed: p, windows: [{ lane: 'a', window: [1005, 1025] }] });
  assert.equal(two.a.instructions.total, 525);
  assert.match(two.b.instructions.unavailable, /no measured window/);
});
