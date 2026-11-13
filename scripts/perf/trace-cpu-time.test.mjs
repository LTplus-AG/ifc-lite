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

test('the report section shows per-side CPU medians and the A/A floor, and nothing without CPU time', async () => {
  const { cpuTimeSection } = await import('./load-scoreboard-report-sections.mjs');
  const row = (side, round, wall, total) => ({ ok: true, fixture: 'FZK', lane: 'browser-cold', side, round, interactiveMs: wall,
    cpuTime: { cpuMs: { total, rendererMain: total / 2, workers: total / 4, gpu: 10 }, stages: { 'scene.finalize': { mainCpuMs: 5 } } } });
  const samples = [row('base', 0, 500, 1000), row('branch', 0, 520, 1000), row('base', 1, 510, 1010), row('branch', 1, 505, 1010),
    row('base', 2, 490, 990), row('branch', 2, 600, 990), { ok: true, fixture: 'FZK', lane: 'native-cold', side: 'base', round: 0 }];
  const lines = cpuTimeSection(samples, 'aa');
  const fzk = lines.find((l) => l.startsWith('| FZK |'));
  assert.ok(fzk, lines.join('\n'));
  assert.match(fzk, /\| 3\/3 \| 500 \/ 520; floor /);
  assert.match(fzk, /\| 1,000 \/ 1,000; floor 0\.\d%/); // identical CPU on both sides: floor from scatter only
  assert.match(cpuTimeSection(samples, 'ab').find((l) => l.startsWith('| FZK |')), /1,000 \/ 1,000; 0\.0% \(floor/);
  assert.deepEqual(cpuTimeSection(samples.map(({ cpuTime: _c, ...r }) => r), 'aa'), []);
});
