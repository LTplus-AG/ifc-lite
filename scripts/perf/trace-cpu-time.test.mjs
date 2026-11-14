/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// CPU time per thread role and per stage from a Chrome trace (trace-cpu-time.mjs), on a hand-made trace whose
// answer is known: page clock = trace clock - 1,000,000 us, window = page 100..600 ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { traceCpuTime, resolveWindow, traceEventsOf } from './trace-cpu-time.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
// Fixtures are loaded as modules (data, not source text to assert on).
const load = createRequire(import.meta.url);
const trace = load('./trace-cpu-time.fixture.json');
const spans = load('./trace-cpu-time.spans.fixture.json');

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
  // The 0.1 ms EpollEvent without tdur is wall the trace could not attribute.
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
  const MARKS = new Set(['scoreboard:input', 'scoreboard:interactive']);
  const events = traceEventsOf(trace).filter((e) => !MARKS.has(e.name));
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
  assert.match(cpuTimeSection(aaRows, summary).find((l) => l.startsWith('| FZK |')), /\| 6\/6; pairs CPU 6 \| 503 \/ 508 \| 1,003 \/ 1,004 \|/);
  const busy = cpuTimeSummary(plan, aaRows.map((r, i) => (i === 0 ? { ...r, host: { underLoad: true } } : r)));
  assert.equal(busy.cells[0].aaFloor, null);
  // Compare: a 20% CPU gain with a 1% CPU A/A floor passes; without a CPU floor in the reference it is inconclusive.
  const ab = rounds.flatMap((n) => [row('base', n, 500, 1000 + n), row('branch', n, 500, 800 + n)]);
  const floors = { FZK: { 'browser-cold': { interactiveMs: 0.03, cpuTotalMs: 0.01 } } };
  assert.equal(cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, ab, { floors }).cells[0].verdict.verdict, 'gain');
  assert.match(cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, ab, { floors: { FZK: { 'browser-cold': { interactiveMs: 0.03 } } } }).cells[0].verdict.verdict, /^inconclusive: no CPU A\/A floor/);
  assert.deepEqual(cpuTimeSection(ab.map(({ cpuTime: _c, ...r }) => r), { cpuTime: cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, ab.map(({ cpuTime: _c, ...r }) => r)) }), []);
});

test('only toplevel task events count: a non-toplevel event spanning a task does not hide its thread time', () => {
  const extra = { ph: 'X', cat: 'devtools.timeline', name: 'Wrapper', pid: 10, tid: 1, ts: 1190000, dur: 70000 };
  const r = traceCpuTime({ traceEvents: [...traceEventsOf(trace), extra] });
  assert.equal(r.cpuMs.rendererMain, 90);
});

test('a trace without thread time reports CPU as unavailable (null), never as a measured zero', () => {
  const events = traceEventsOf(trace).map(({ tdur: _t, ...e }) => e);
  const r = traceCpuTime(events, { spans });
  assert.equal(r.threadTime, false);
  assert.equal(r.cpuMs.total, null);
  assert.equal(r.cpuMs.rendererMain, null);
  assert.equal(r.stages, null);
});

test('thread time only after the window does not make an untimed window read as zero CPU', () => {
  const ev = traceEventsOf(trace).filter((e) => e.ph !== 'X').concat([
    { ph: 'X', cat: 'toplevel', name: 'T', pid: 10, tid: 1, ts: 1200000, dur: 50000 }, // inside, no tdur
    { ph: 'X', cat: 'toplevel', name: 'T', pid: 10, tid: 1, ts: 1700000, dur: 50000, tdur: 50000 }, // after the window
  ]);
  const r = traceCpuTime(ev);
  assert.equal(r.threadTime, false);
  assert.equal(r.cpuMs.total, null);
});

test('stages are anchored at the input event (scoreboard:origin) even when the window starts earlier (first-paint arm)', () => {
  // Window from page 50 ms (first paint) to 600 ms; input event at 100 ms: span times stay relative to 100 ms.
  const ev = traceEventsOf(trace).map((e) => (e.name === 'scoreboard:input' ? { ...e, ts: 1050000, args: { data: { startTime: 50 } } } : e))
    .concat([{ ph: 'I', cat: 'blink.user_timing', name: 'scoreboard:origin', pid: 10, tid: 1, ts: 1100000, args: { data: { startTime: 100 } } }]);
  const r = traceCpuTime(ev, { spans });
  assert.deepEqual(r.stages['scene.finalize'], { wallMs: 50, mainCpuMs: 50 }); // page 200..250, as with the input-anchored window
});

test('CPU is unavailable when only another process has thread time (renderer main untimed): no partial total', () => {
  const ev = traceEventsOf(trace).map((e) => (e.ph === 'X' && e.pid === 10 ? (({ tdur: _t, ...x }) => x)(e) : e));
  const r = traceCpuTime(ev);
  assert.equal(r.coverage, 'renderer main thread has no thread time in the window');
  assert.equal(r.cpuMs.total, null);
  assert.equal(r.cpuMs.gpu, null);
});

test('stage intervals are clipped to the input-to-interactive window, like the total', () => {
  // A span from 600 ms after the input (page 700) runs past the interactive mark (page 600): the main task at 700-750 is out.
  const late = [{ attrs: {}, startMs: 0, endMs: 700, spans: [['late.stage', 'main', 600, 100, 0, 9, null]] }];
  const r = traceCpuTime(trace, { spans: late });
  assert.equal(r.stages['late.stage'], undefined);
});

test('a requested second measure that was unavailable is shown with its count and reason; verdicts use complete rounds only', async () => {
  const { cpuTimeSummary, cpuTimeSection } = await import('./load-scoreboard-report-cpu.mjs');
  const rows = [0, 1, 2].flatMap((n) => ['base', 'branch'].map((side) => ({ ok: true, fixture: 'FZK', lane: 'browser-cold', side, round: n, interactiveMs: 500,
    cpuTime: { cpuMs: { total: null }, coverage: 'no thread time in the window' } })));
  const line = cpuTimeSection(rows, { cpuTime: cpuTimeSummary({ kind: 'aa', lanes: ['browser-cold'] }, rows) }).find((l) => l.startsWith('| FZK |'));
  assert.match(line, /CPU unavailable 6: no thread time in the window/);
  // Base 100, 200, 10000 and branch 100, 200, unavailable: the shared rounds show no gain.
  const cpu = [[100, 100], [200, 200], [10000, null]].flatMap(([b, r], n) => [
    { ok: true, fixture: 'FZK', lane: 'browser-cold', side: 'base', round: n, interactiveMs: 500, cpuTime: { cpuMs: { total: b } } },
    { ok: true, fixture: 'FZK', lane: 'browser-cold', side: 'branch', round: n, interactiveMs: 500, cpuTime: { cpuMs: { total: r } } }]);
  const v = cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, cpu).cells[0].verdict;
  assert.equal(v.gain, 0);
});

test('worker marks of the renderer process (their own time origin) do not shift the page-clock offset', () => {
  const skew = [0, 1, 2].map((i) => ({ ph: 'I', cat: 'blink.user_timing', name: `w${i}`, pid: 10, tid: 2, ts: 1300000 + i, args: { data: { startTime: 100 + i / 1000 } } }));
  const r = traceCpuTime([...traceEventsOf(trace), ...skew]);
  assert.equal(r.window.startMs, 100);
  assert.equal(r.cpuMs.rendererMain, 90); // unchanged: offset from the scoreboard marks
  // Fallback (no scoreboard marks): only main-thread marks align the clock.
  const plain = traceEventsOf(trace).filter((e) => !String(e.name).includes('scoreboard')).concat(skew);
  assert.equal(traceCpuTime(plain, { window: [200, 250] }).cpuMs.rendererMain, 50);
});

test('CPU verdicts follow the wall arm-protocol gate; their medians come from the compared rounds', async () => {
  const { cpuTimeSummary, applyArmProtocolGate } = await import('./load-scoreboard-report-cpu.mjs');
  const row = (side, n, v) => ({ ok: true, fixture: 'FZK', lane: 'browser-cold-settled', side, round: n, interactiveMs: 500, cpuTime: { cpuMs: { total: v } } });
  const rows = [0, 1, 2, 3, 4].flatMap((n) => [row('base', n, 1000 + n), row('branch', n, 800 + n)]);
  const floors = { FZK: { 'browser-cold-settled': { cpuTotalMs: 0.01 } } };
  const cpu = cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold-settled'] }, rows, { floors });
  assert.equal(cpu.cells[0].verdict.verdict, 'gain');
  const summary = { fixtures: [{ name: 'FZK', lanes: { 'browser-cold-settled': { armProtocol: { same: false, declaredAsymmetric: false, base: { signals: ['true'] }, branch: { signals: ['no signal'] } } } } }] };
  applyArmProtocolGate(cpu, summary);
  assert.match(cpu.cells[0].verdict.verdict, /^inconclusive: arming protocols differ/);
  // Medians from complete rounds: base 100, 200, 10000 vs branch 100, 200, unavailable -> 150 / 150.
  const mixed = [[100, 100], [200, 200], [10000, null]].flatMap(([b, r], n) => [
    { ok: true, fixture: 'FZK', lane: 'browser-cold', side: 'base', round: n, interactiveMs: 1, cpuTime: { cpuMs: { total: b } } },
    { ok: true, fixture: 'FZK', lane: 'browser-cold', side: 'branch', round: n, interactiveMs: 1, cpuTime: { cpuMs: { total: r } } }]);
  const c = cpuTimeSummary({ kind: 'compare', lanes: ['browser-cold'] }, mixed).cells[0];
  assert.deepEqual(c.medians.total, [150, 150]);
  assert.equal(c.pairs.cpu, 2);
});

test('A/A floors of a -settled cell with undeclared different arming are withheld; the fallback clock needs the main thread', async () => {
  const { cpuTimeSummary, applyArmProtocolGate, addCpuFloors } = await import('./load-scoreboard-report-cpu.mjs');
  const row = (side, n, v) => ({ ok: true, fixture: 'FZK', lane: 'browser-cold-settled', side, round: n, interactiveMs: 500, cpuTime: { cpuMs: { total: v } } });
  const rows = [0, 1, 2, 3, 4].flatMap((n) => [row('base', n, 1000 + n), row('branch', n, 1001 + n)]);
  const cpu = cpuTimeSummary({ kind: 'aa', lanes: ['browser-cold-settled'] }, rows);
  assert.ok(cpu.cells[0].aaFloor > 0);
  const summary = { floors: {}, fixtures: [{ name: 'FZK', lanes: { 'browser-cold-settled': { armProtocol: { same: false, declaredAsymmetric: false, base: { signals: ['true'] }, branch: { signals: ['no signal'] } } } } }] };
  addCpuFloors(summary, applyArmProtocolGate(cpu, summary));
  assert.deepEqual(summary.floors.FZK['browser-cold-settled'], { cpuTotalMs: null });
  // No scoreboard marks and no CrRendererMain metadata: the page clock cannot be identified, so no window is guessed.
  const bare = traceEventsOf(trace).filter((e) => e.ph !== 'M' && !String(e.name).includes('scoreboard'));
  assert.throws(() => traceCpuTime(bare, { window: [200, 250] }), /cannot align the page clock/);
});

test('untimed coverage is judged over the roles the total sums, so other processes\' timed work cannot dilute a gap', () => {
  // Renderer main: 100 ms untimed + 1 ms timed; another renderer: 2,000 ms timed. Over all processes 100/2,101 = 4.8 %
  // would pass; over the load's own roles the main thread is 99 % untimed, so CPU is unavailable.
  const base = traceEventsOf(trace).filter((e) => e.ph === 'M' || e.cat === 'blink.user_timing');
  const ev = base.concat([
    { ph: 'X', cat: 'toplevel', name: 'T', pid: 10, tid: 1, ts: 1150000, dur: 100000 },
    { ph: 'X', cat: 'toplevel', name: 'T', pid: 10, tid: 1, ts: 1300000, dur: 1000, tdur: 1000 },
    ...Array.from({ length: 4 }, (_, i) => ({ ph: 'X', cat: 'toplevel', name: 'T', pid: 40, tid: 1, ts: 1100000 + i * 100000, dur: 100000, tdur: 100000 })),
    ...Array.from({ length: 16 }, (_, i) => ({ ph: 'X', cat: 'toplevel', name: 'T', pid: 40, tid: 2 + i, ts: 1100000, dur: 100000, tdur: 100000 })),
  ]);
  const r = traceCpuTime(ev);
  assert.equal(r.cpuMs.total, null);
  assert.equal(Math.round(r.uncountedWallShareByRole.rendererMain * 100) / 100, 0.99);
  assert.ok(r.coverage.startsWith('rendererMain 99.0%'), r.coverage);
});

test('a dedicated worker in a renderer other than the page\'s is detected: CPU unavailable, never silently dropped', () => {
  const ev = traceEventsOf(trace).concat([
    { ph: 'M', name: 'thread_name', pid: 40, tid: 7, args: { name: 'DedicatedWorker thread' } },
    { ph: 'X', cat: 'toplevel', name: 'T', pid: 40, tid: 7, ts: 1200000, dur: 100000, tdur: 100000 },
  ]);
  const r = traceCpuTime(ev);
  assert.equal(r.cpuMs.total, null);
  assert.equal(r.coverage, 'dedicated worker thread(s) in another renderer (pid 40) are not attributed');
});
