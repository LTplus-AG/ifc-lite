/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// CPU time per thread role and per stage from a Chrome trace (trace-cpu-time.mjs), on a hand-made trace whose
// answer is known: page clock = trace clock - 1,000,000 us, window = page 100..600 ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { traceCpuTime, resolveWindow, traceEventsOf } from './trace-cpu-time.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const trace = JSON.parse(readFileSync(here('./trace-cpu-time.fixture.json'), 'utf8'));
const spans = JSON.parse(readFileSync(here('./trace-cpu-time.spans.fixture.json'), 'utf8'));

test('the window comes from the scoreboard marks and aligns the page clock with the trace clock', () => {
  const w = resolveWindow(traceEventsOf(trace));
  assert.equal(w.pid, 10);
  assert.equal(w.offsetUs, 1_000_000);
  assert.deepEqual([w.startUs, w.endUs], [1_100_000, 1_600_000]);
});

test('thread time per role: straddling tasks by their share inside, nested tasks once, untimed tasks not counted', () => {
  const r = traceCpuTime(trace);
  assert.equal(r.threadTime, true);
  // Main: half of the 80 ms task that straddles the start (its nested 20 ms event is not added) + 50 ms; the task after the end is out.
  assert.equal(r.cpuMs.rendererMain, 90);
  assert.equal(r.cpuMs.workers, 290);
  assert.equal(r.cpuMs.rendererOther, 3);
  assert.equal(r.cpuMs.gpu, 9);
  assert.equal(r.cpuMs.browser, 6);
  assert.equal(r.cpuMs.otherRenderers, 5);
  assert.equal(r.cpuMs.total, 90 + 290 + 3 + 9);
  // The 10 ms EpollEvent without tdur is wall the trace could not attribute.
  assert.ok(r.uncountedWallShare > 0 && r.uncountedWallShare < 0.05);
  assert.equal(r.window.wallMs, 500);
});

test('stages: main-thread CPU inside the union of a span name; worker-framing spans also get worker CPU; milestones skipped', () => {
  const r = traceCpuTime(trace, { spans });
  assert.deepEqual(r.stages['scene.finalize'], { wallMs: 50, mainCpuMs: 50 });
  assert.deepEqual(r.stages['geometry.pool'], { wallMs: 500, mainCpuMs: 90, workersCpuMs: 290 });
  assert.equal(r.stages['geometry.firstVisible'], undefined);
  assert.equal(r.stages['shard.scan'], undefined); // worker-thread spans only: no main-thread interval
});

test('an explicit window overrides the marks and still aligns through any mark', () => {
  const events = traceEventsOf(trace).filter((e) => !String(e.name).startsWith('scoreboard:'));
  assert.throws(() => traceCpuTime(events), /no scoreboard:input/);
  const r = traceCpuTime(events, { window: [200, 250] });
  assert.equal(r.window.source, 'explicit window');
  assert.equal(r.cpuMs.rendererMain, 50);
  assert.equal(r.cpuMs.workers, 48.33); // 290 ms x 50/300 of the task inside, rounded to 0.01 ms
});

test('the CLI prints the same totals', () => {
  const out = spawnSync(process.execPath, [here('./trace-cpu-time.mjs'), here('./trace-cpu-time.fixture.json'), '--json'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).cpuMs.total, 392);
});

test('CPU time is a second measure: per-side medians, A/A floor (none with a busy sample), and its own verdict column', async () => {
  const { cpuTimeSummary, cpuTimeSection, addCpuFloors } = await import('./load-scoreboard-report-cpu.mjs');
  const row = (side, round, wall, total, extra = {}) => ({ ok: true, fixture: 'FZK', lane: 'browser-cold', side, round, interactiveMs: wall,
    cpuTime: { cpuMs: { total, rendererMain: total / 2, workers: total / 4, gpu: 10 }, stages: { 'scene.finalize': { mainCpuMs: 5 } } }, ...extra });
  const rounds = [0, 1, 2, 3, 4, 5];
  const aaRows = rounds.flatMap((n) => [row('base', n, 500 + n, 1000 + n), row('branch', n, 505 + n, 1001 + n)]);
  const plan = { kind: 'aa', lanes: ['native-cold', 'browser-cold'] };
  const aa = cpuTimeSummary(plan, [...aaRows, { ok: true, fixture: 'FZK', lane: 'native-cold', side: 'base', round: 0 }]);
  assert.equal(aa.cells.length, 1);
  assert.ok(aa.cells[0].aaFloor > 0 && aa.cells[0].aaFloor < 0.01);
  const summary = { floors: {}, cpuTime: aa };
  addCpuFloors(summary, aa);
  assert.equal(summary.floors.FZK['browser-cold'].cpuTotalMs, aa.cells[0].aaFloor);
  assert.match(cpuTimeSection(aaRows, summary).find((l) => l.startsWith('| FZK |')), /\| 6\/6 \| 503 \/ 508 \| 1,003 \/ 1,004 \|/);
  const busy = cpuTimeSummary(plan, aaRows.map((r, i) => (i === 0 ? { ...r, host: { underLoad: true } } : r)));
  assert.equal(busy.cells[0].aaFloor, null);
  // Compare: a 20% CPU gain with a 1% CPU A/A floor passes; without a CPU floor in the reference it is inconclusive.
  const ab = rounds.flatMap((n) => [row('base', n, 500, 1000 + n), row('branch', n, 500, 800 + n)]);
  const floors = { FZK: { 'browser-cold': { interactiveMs: 0.03, cpuTotalMs: 0.01 } } };
  assert.equal(cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, ab, { floors }).cells[0].verdict.verdict, 'gain');
  assert.match(cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, ab, { floors: { FZK: { 'browser-cold': { interactiveMs: 0.03 } } } }).cells[0].verdict.verdict, /^inconclusive: no CPU A\/A floor/);
  assert.deepEqual(cpuTimeSection(ab.map(({ cpuTime: _c, ...r }) => r), { cpuTime: cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, ab.map(({ cpuTime: _c, ...r }) => r)) }), []);
});
