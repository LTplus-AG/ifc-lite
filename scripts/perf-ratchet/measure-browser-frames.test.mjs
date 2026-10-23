// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6975 / M4 #6959: the `browser-frames` ratchet family. The inputs are a REAL
// admitted artifact of .github/workflows/browser-frames.yml on main and a REAL
// GPU-contaminated sample from a hosted run; scripts/perf/frame-ratchet-evidence.test.mjs
// binds both to their run receipts in the committed evidence. The CLIs run as
// child processes, exactly as the workflows call them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadCeilingFile, validateMeasuredFile } from './ceilings.mjs';
import { allowedMax, compareFamily, REGRESSION } from './compare.mjs';
import { buildMeasured, frameMetricId, RATCHETED_FRAME_METRICS } from './measure-browser-frames.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../tests/evidence/frame-ratchet-6975/', import.meta.url));
const CEILINGS = loadCeilingFile(fileURLToPath(new URL('../../tests/perf-ratchets/browser-frames.json', import.meta.url)));
const MEASURER = join(HERE, 'measure-browser-frames.mjs');
const CLI = join(HERE, 'perf-ratchet.mjs');

const admitted = () => JSON.parse(readFileSync(join(FIXTURES, 'admitted.browser-frames.json'), 'utf8'));
const contaminatedSample = () => JSON.parse(readFileSync(join(FIXTURES, 'contaminated-sample.json'), 'utf8')).sample;
const gated = new Set(RATCHETED_FRAME_METRICS);
const keyOf = (row) => `${row.fixture}/${row.scenario}/${row.metric}`;

/** Run measure-browser-frames then `perf-ratchet check`, as browser-frames.yml does. */
function measureAndCheck(evidence) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-frames-'));
  try {
    const frames = join(dir, 'browser-frames.json');
    const out = join(dir, 'measured', 'browser-frames.json');
    writeFileSync(frames, JSON.stringify(evidence));
    const measure = spawnSync(process.execPath, [MEASURER, '--frames', frames, '--out', out, '--commit', 'abc1234'], { encoding: 'utf8' });
    const written = existsSync(out);
    const check = measure.status === 0 ? spawnSync(process.execPath, [CLI, 'check', '--measured', out], { encoding: 'utf8' }) : null;
    return { measure, written, check };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#6975 an admitted main artifact passes the committed browser-frames ceilings', () => {
  const measured = buildMeasured({ evidence: admitted(), commit: 'abc1234' });
  assert.deepEqual(validateMeasuredFile(measured), []);
  assert.deepEqual(measured.metrics.map((m) => m.id).sort(), CEILINGS.entries.map((e) => e.id).sort());
  const result = compareFamily(CEILINGS, measured);
  assert.equal(result.failed, false, JSON.stringify(result.rows));
  const run = measureAndCheck(admitted());
  assert.equal(run.measure.status, 0, run.measure.stderr);
  assert.equal(run.check.status, 0, run.check.stdout + run.check.stderr);
});

test('#6975 a ratcheted row above ceiling + tolerance fails the check', () => {
  for (const key of RATCHETED_FRAME_METRICS) {
    const evidence = admitted();
    const row = evidence.rows.find((r) => keyOf(r) === key);
    const entry = CEILINGS.entries.find((e) => e.id === frameMetricId(row.fixture, row.scenario, row.metric));
    row.value = allowedMax(entry) + 1;
    const { measure, check } = measureAndCheck(evidence);
    assert.equal(measure.status, 0, measure.stderr);
    assert.equal(check.status, 1, `${key}: ${check.stdout}${check.stderr}`);
    assert.equal(compareFamily(CEILINGS, buildMeasured({ evidence, commit: 'a' })).rows.find((r) => r.id === entry.id).status, REGRESSION);
  }
});

test('#6975 a GPU-contaminated artifact is refused, never evaluated (#7601 Dawn instance loss)', () => {
  const evidence = admitted();
  const sample = contaminatedSample();
  const at = evidence.samples.findIndex((s) => s.fixture === sample.fixture);
  // Only the health witness changes; every row stays inside its ceiling, so
  // the refusal can only come from admission, not from a value that fails.
  evidence.samples[at] = { ...evidence.samples[at], gpuHealth: sample.gpuHealth };
  assert.throws(() => buildMeasured({ evidence, commit: 'a' }), /GPU-contaminated/);
  const run = measureAndCheck(evidence);
  assert.equal(run.measure.status, 2, run.measure.stdout);
  assert.equal(run.written, false, 'a refused artifact writes no measured file');
});

test('#6975 an incomplete artifact is refused rather than measured on the rows it has', () => {
  const evidence = admitted();
  evidence.rows = evidence.rows.filter((r) => !gated.has(keyOf(r)) || r.fixture !== 'Snowdon');
  assert.throws(() => buildMeasured({ evidence, commit: 'a' }), /missing frame metrics/);
  const run = measureAndCheck(evidence);
  assert.equal(run.measure.status, 2);
  assert.equal(run.written, false);
  const replaced = admitted();
  replaced.refusedAttempts = [{ ...contaminatedSample(), attempt: 1 }];
  assert.throws(() => buildMeasured({ evidence: replaced, commit: 'a' }), /attempt receipts/);
});

test('#6975 non-ratcheted rows are informational: a tenfold main-thread or orbit-draw rise is not judged', () => {
  const evidence = admitted();
  const MAIN_THREAD = new Set(['main_thread_ms_total', 'main_thread_ms_p50', 'main_thread_ms_p95', 'main_thread_ms_max', 'script_ms_total', 'raf_js_ms_total', 'raf_js_ms_p95']);
  const ORBIT_GPU = new Set(['gpu_submits', 'gpu_draws', 'gpu_write_kib']);
  let inflated = 0;
  for (const row of evidence.rows) {
    if (gated.has(keyOf(row))) continue;
    if (MAIN_THREAD.has(row.metric) || (row.scenario === 'orbit' && ORBIT_GPU.has(row.metric))) {
      row.value = row.value * 10 + 1;
      inflated += 1;
    }
  }
  assert.equal(inflated, 2 * 3 * MAIN_THREAD.size + 2 * ORBIT_GPU.size);
  const measured = buildMeasured({ evidence, commit: 'a' });
  assert.equal(measured.metrics.length, RATCHETED_FRAME_METRICS.length);
  assert.equal(measured.informational.length, evidence.rows.length - RATCHETED_FRAME_METRICS.length);
  const info = new Map(measured.informational.map((m) => [m.id, m.value]));
  const draws = evidence.rows.find((r) => keyOf(r) === 'Snowdon/orbit/gpu_draws');
  assert.equal(info.get('snowdon/orbit/gpu-draws'), draws.value, 'the inflated value is reported as-is');
  assert.equal(compareFamily(CEILINGS, measured).failed, false);
  const run = measureAndCheck(evidence);
  assert.equal(run.check.status, 0, run.check.stdout);
});
