/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Huge-geometry harness reporting: frame-time percentiles, the failure
// classifier's precedence and the ladder/compare tables are what later spike
// lanes read their verdicts from, so they are pinned on synthetic inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const load = async (name) => { const u = new URL(name, import.meta.url); return existsSync(u) ? import(u.href) : null; };
const report = await load('./huge-geometry-report.mjs');
const browser = await load('./huge-geometry-browser.mjs');
const run = await load('./huge-geometry-run.mjs');
const need = (m, name) => { assert.ok(m, `scripts/perf/${name} does not exist`); return m; };

test('nearest-rank percentiles', () => {
  const { percentile } = need(report, 'huge-geometry-report.mjs');
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 0.5), 50);
  assert.equal(percentile(v, 0.95), 95);
  assert.equal(percentile(v, 0.99), 99);
  assert.equal(percentile(v, 1), 100);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([NaN, 3], 0.5), 3);
});

test('frame summary reads frame time from rAF deltas, including one long stall', () => {
  const { frameSummary } = need(report, 'huge-geometry-report.mjs');
  const records = Array.from({ length: 101 }, (_, i) => ({ ts: i * 16.67 + (i >= 50 ? 200 : 0), cbMs: 1, draws: 10, tris: 3e6, presents: 1, cpuMs: 2, batches: 9, instanced: 1, culled: 0, indirect: 0 }));
  const s = frameSummary(records);
  assert.equal(s.frames, 101);
  assert.equal(s.frameMs.median, 16.67);
  assert.equal(s.frameMs.worst, 216.67);
  assert.equal(s.drawsPerFrame.median, 10);
  assert.equal(s.trianglesPerFrame.median, 3e6);
});

test('failure classification: crash beats device loss beats OOM beats store error beats timeout', () => {
  const { classifyFailure } = need(browser, 'huge-geometry-browser.mjs');
  const base = { crashed: false, deviceLost: null, storeError: null, pageErrors: [], timedOut: null, console: [] };
  assert.equal(classifyFailure({ ...base, crashed: true, deviceLost: 'x', timedOut: 'y' }).kind, 'renderer-crash');
  assert.equal(classifyFailure({ ...base, deviceLost: '[WebGPU] Device lost: (reason: unknown)', storeError: 'boom' }).kind, 'device-lost');
  assert.equal(classifyFailure({ ...base, storeError: 'Failed', console: ['[error] RangeError: Array buffer allocation failed'] }).kind, 'out-of-memory');
  assert.equal(classifyFailure({ ...base, storeError: 'Model could not be loaded', timedOut: 't' }).kind, 'load-error');
  assert.equal(classifyFailure({ ...base, timedOut: 'not interactive after 60 s' }).kind, 'timeout');
  assert.equal(classifyFailure(base).kind, 'unknown');
});

test('ladder table lists every run and its failure; compare pairs runs by name', () => {
  const { markdownSummary, markdownCompare } = need(report, 'huge-geometry-report.mjs');
  const mk = (name, nominal, status, completeMs, failure) => ({ scenario: { name, scenario: 'mixed', nominal, elements: nominal, models: 1 }, status,
    generated: { totals: { elements: nominal, bytes: 2 ** 20 } }, load: { timings: { interactiveMs: completeMs } }, failure,
    camera: { orbit: { frameMs: { median: 16.7, p95: 20, p99: 30, worst: 40 } } } });
  const base = [mk('mixed-10k', 10000, 'ok', 2000), mk('mixed-100k', 100000, 'failed', null, { kind: 'out-of-memory', detail: 'Array buffer allocation failed' })];
  const md = markdownSummary(base, { label: 'baseline' });
  assert.match(md, /\| mixed \| 10000 \| 10000 \|/);
  assert.match(md, /mixed-100k\*\*: out-of-memory: Array buffer allocation failed/);
  const next = [mk('mixed-10k', 10000, 'ok', 1000), mk('mixed-100k', 100000, 'ok', 9000)];
  const cmp = markdownCompare(base, next, { baseLabel: 'baseline', nextLabel: 'spike' });
  assert.match(cmp, /\| mixed-10k \| ok → ok \| 2 → 1 \(×0\.5\)/);
  assert.match(cmp, /\| mixed-100k \| failed → ok \|/);
});

test('tier labels parse', () => {
  const { parseTier } = need(run, 'huge-geometry-run.mjs');
  assert.equal(parseTier('10k'), 10000);
  assert.equal(parseTier('2M'), 2000000);
  assert.equal(parseTier('250000'), 250000);
  assert.throws(() => parseTier('1e6'), /bad tier/);
});

test('bounded: settles with the promise, or rejects naming the step', async () => {
  const { bounded } = need(browser, 'huge-geometry-browser.mjs');
  assert.equal(await bounded(Promise.resolve('done'), 60000, 'quick'), 'done');
  await assert.rejects(bounded(new Promise(() => {}), 5, 'camera orbit'), /camera orbit timed out after 5 ms/);
});
