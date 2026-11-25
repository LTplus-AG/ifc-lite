/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Huge-geometry harness reporting: frame-time percentiles, the failure
// classifier's precedence and the ladder/compare tables are what later spike
// lanes read their verdicts from, so they are pinned on synthetic inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.deepEqual(s.hitches, { over50Ms: 1, over100Ms: 1 }, 'the one stall is a hitch past both bounds');
  assert.equal(frameSummary(records.slice(0, 1)).hitches, null, 'one frame has no interval: hitches unmeasured, not zero');
  assert.equal(s.spanMs, Math.round(100 * 16.67 + 200));
  assert.equal(s.fps, Math.round((100 * 10000) / (100 * 16.67 + 200)) / 10);
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
  assert.equal(classifyFailure({ ...base, loadError: 'Execution context was destroyed' }).kind, 'load-error');
  assert.equal(classifyFailure({ ...base, loadError: 'boom', pageErrors: ['TypeError: x'] }).kind, 'page-error');
  assert.equal(classifyFailure(base).kind, 'unknown');
});

test('ladder table lists every run and its failure; compare pairs runs by name', () => {
  const { markdownSummary, markdownCompare } = need(report, 'huge-geometry-report.mjs');
  const mk = (name, nominal, status, completeMs, failure) => ({ scenario: { name, scenario: 'mixed', nominal, elements: nominal, models: 1 }, status,
    generated: { totals: { elements: nominal, bytes: 2 ** 20 } }, load: { timings: { interactiveMs: completeMs } }, failure,
    camera: { orbit: { frameMs: { median: 16.7, p95: 20, p99: 30, worst: 40 }, fps: 55.5, hitches: { over50Ms: 3, over100Ms: completeMs === 9000 ? 2 : 0 } } } });
  const base = [mk('mixed-10k', 10000, 'ok', 2000), mk('mixed-100k', 100000, 'failed', null, { kind: 'out-of-memory', detail: 'Array buffer allocation failed' })];
  const md = markdownSummary(base, { label: 'baseline' });
  assert.match(md, /\| mixed \| 10000 \| 10000 \|/);
  assert.match(md, /mixed-100k\*\*: out-of-memory: Array buffer allocation failed/);
  const next = [mk('mixed-10k', 10000, 'ok', 1000), mk('mixed-100k', 100000, 'ok', 9000)];
  const cmp = markdownCompare(base, next, { baseLabel: 'baseline', nextLabel: 'spike' });
  assert.match(cmp, /\| mixed-10k \| ok → ok \| 2 → 1 \(×0\.5\)/);
  assert.match(cmp, /\| mixed-100k \| failed → ok \|/);
  assert.match(md, /\| 40 \| 55\.5 \| 3 \| 0 \| – \|/, 'orbit fps and hitches >50 / >100 follow orbit worst; no zoom path');
  assert.match(cmp, /\| mixed-100k \| failed → ok \|.*\| 55\.5 → 55\.5 \(×1\) \| 0 → 2 \|/, 'hitches over a zero base have no ratio');
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


function runHarnessCli(name, dir, ...args) {
  const script = fileURLToPath(new URL(`huge-geometry-${name}.mjs`, import.meta.url));
  const result = spawnSync(process.execPath, [script, '--label', 'test', '--out', join(dir, 'out'),
    '--models-dir', join(dir, 'models'), '--dist', join(dir, 'missing-viewer'), ...args], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

test('#11366: all numeric CLI options exit with usage for invalid values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huge-geometry-options-'));
  try {
    for (const [name, options] of Object.entries({
      run: { 'timeout-min': 'abc', frames: '0', seed: '-1' },
      record: { 'timeout-min': 'abc', frames: '-2', fps: 'Infinity' },
      cinema: { 'timeout-min': 'abc', fps: '0', seed: '-1', 'load-speed': 'Infinity', 'emit-max-mb': '0' },
    })) {
      for (const [key, value] of Object.entries(options)) {
        const result = runHarnessCli(name, dir, `--${key}=${value}`);
        const expected = { frames: 'a positive integer', seed: 'a non-negative integer' }[key] ?? 'a positive finite number';
        assert.equal(result.status, 2, result.stderr);
        assert.ok(result.stderr.includes(`--${key} must be ${expected}`), result.stderr);
        assert.ok(result.stderr.includes(`usage: huge-geometry-${name}.mjs`), result.stderr);
        assert.equal(existsSync(join(dir, 'out')), false);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#11366: CLI seeds accept zero and reject fractions, and frame counts reject fractions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huge-geometry-integer-options-'));
  try {
    for (const [name, key, expected] of [
      ['run', 'seed', 'a non-negative integer'], ['cinema', 'seed', 'a non-negative integer'],
      ['run', 'frames', 'a positive integer'], ['record', 'frames', 'a positive integer'],
    ]) {
      const result = runHarnessCli(name, dir, `--${key}=${key === 'seed' ? '1.5' : '2.5'}`);
      assert.equal(result.status, 2, result.stderr);
      assert.ok(result.stderr.includes(`--${key} must be ${expected}`), result.stderr);
      assert.ok(result.stderr.includes(`usage: huge-geometry-${name}.mjs`), result.stderr);
    }

    const run = runHarnessCli('run', dir, '--seed=0', '--generate-only', '--scenarios=mixed', '--tiers=10');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /generated 10 elements/);

    const cinema = runHarnessCli('cinema', dir, '--seed=0');
    assert.equal(cinema.status, 1, cinema.stderr);
    assert.ok(cinema.stderr.includes(`no viewer build at ${join(dir, 'missing-viewer')}`), cinema.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#11366: a missing rendered frame is a named error for each required store interaction', async () => {
  const { interactions } = await import('./huge-geometry-measure.mjs');
  const { AFTER_FRAME, ELEMENT_IDS, READ_PICK, STORE_ACTION } = await import('./huge-geometry-page.mjs');
  const frameError = 'no rendered frame done within 60000 ms';
  let action;
  const page = {
    async evaluate(fn, args) {
      if (fn === READ_PICK) return { hit: false };
      if (fn === ELEMENT_IDS) return { ids: [42], total: 1 };
      if (fn === STORE_ACTION) { action = args.action; return { syncMs: 1 }; }
      if (fn === AFTER_FRAME) return { presentMs: 2, doneMs: null, doneError: action === 'showAll' ? undefined : frameError };
    },
    async waitForFunction() {},
    async waitForTimeout() {},
    locator: () => ({ first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }) }) }),
    mouse: { async click() {} },
  };
  const errors = [];
  const result = await interactions(page, errors);
  assert.deepEqual(errors, ['hide-one', 'isolate', 'section-on', 'section-off'].map((step) => ({ step, error: frameError })));
  assert.equal(result.hideOne, null);
  assert.equal(result.isolate, null);
  assert.equal(result.sectionOn, null);
  assert.equal(result.sectionOff, null);
});
