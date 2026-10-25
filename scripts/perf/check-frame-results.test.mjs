/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { FRAME_FIXTURES, FRAME_SCENARIOS, MAX_ATTEMPTS, requireFrameEvidence } = await tsImport('../../tests/benchmark/frames/frame-evidence.ts', import.meta.url);
const { drivenFrameRows, FRAME_BUDGET_MS } = await tsImport('../../tests/benchmark/frames/frame-stats.ts', import.meta.url);
const { gpuHealthFrom } = await tsImport('../../tests/benchmark/gpu-health.ts', import.meta.url);

function evidence() {
  // Stated invariant: every fixture/scenario contains the full statistics
  // emitted by the real reducer, with one completed, observed healthy device.
  const frame = { mainThreadMs: 2, scriptMs: 1, skippedSlots: 0,
    page: { presents: 1, cbMs: 1, submits: 1, outsideSubmits: 0, draws: 1, writeBytes: 0, outsideWriteBytes: 0 } };
  return {
    family: 'browser-frames', rig: 'deterministic-begin-frame', schema: 2,
    frameBudgetMs: FRAME_BUDGET_MS, browser: 'chrome-headless-shell invariant',
    samples: FRAME_FIXTURES.map(({ name }) => ({ fixture: name, attempt: 1, completed: true, error: null,
      readinessError: null,
      readiness: { ended: true, done: ['parser.complete', 'geometry.streamComplete', 'scene.finalize'], failed: [] },
      pageErrors: [], gpuHealth: gpuHealthFrom([], { 'gpu.devices': 1 }) })),
    refusedAttempts: [],
    rows: FRAME_FIXTURES.flatMap(({ name }) => FRAME_SCENARIOS.flatMap(scenario => drivenFrameRows(name, scenario, [frame]))),
  };
}

test('#6975 admits complete real-reducer rows without claiming any metric repeatable', () => {
  assert.doesNotThrow(() => requireFrameEvidence(evidence()));
});

test('#7655 diagnostic runs cannot enter the performance ratchet even with healthy complete frames', () => {
  for (const marker of [
    { performanceEligible: false },
    { instanceDiagnostics: true },
    { performanceEligible: false, instanceDiagnostics: true },
  ]) {
    assert.throws(() => requireFrameEvidence({ ...evidence(), ...marker }), /diagnostic frame evidence is ineligible/);
  }
});

test('#6975 canonical cache readiness uses cache.storeReady instead of demanding a parser rerun', () => {
  const result = evidence();
  result.samples[0].readiness = { ended: true, loadPath: 'cache',
    done: ['cache.storeReady', 'geometry.streamComplete', 'scene.finalize'], failed: [] };
  assert.doesNotThrow(() => requireFrameEvidence(result));
});

test('#6975 six scenario groups cannot hide missing metrics (the former workflow hole)', () => {
  const result = evidence();
  result.rows = result.rows.filter(row => row.metric === 'frames');
  assert.equal(new Set(result.rows.map(row => `${row.fixture}/${row.scenario}`)).size, 6);
  assert.throws(() => requireFrameEvidence(result), /missing frame metrics/);
});

test('#6975 duplicate rows cannot replace an omitted metric even at the expected row count', () => {
  const result = evidence();
  result.rows[1] = { ...result.rows[0] };
  assert.throws(() => requireFrameEvidence(result), /duplicate frame metric/);
});

test('#6975 a complete list of zero rows does not establish any measured scene', () => {
  const result = evidence();
  result.rows.forEach(row => { row.value = 0; });
  assert.throws(() => requireFrameEvidence(result), /empty or inconsistent/);
});

for (const value of [null, -1, NaN, Infinity, '1']) {
  test(`#6975 rejects nonnumeric/nonfinite/negative metric ${String(value)}`, () => {
    const result = evidence();
    result.rows[0].value = value;
    assert.throws(() => requireFrameEvidence(result), /invalid frame metric/);
  });
}

test('#6975 rejects a full recovered sample from canonical GPU-health witnesses', () => {
  for (const health of [
    gpuHealthFrom(['[WebGPU] Device lost: test (reason: unknown)'], { 'gpu.devices': 1 }),
    gpuHealthFrom([], { 'gpu.devices': 2, 'gpu.deviceReplacements': 1 }),
  ]) {
    const result = evidence();
    result.samples[0].gpuHealth = health;
    assert.throws(() => requireFrameEvidence(result), /GPU-contaminated/);
  }
});

test('#6975 refuses missing health, partial execution, page errors and duplicate fixture receipts', () => {
  for (const mutate of [
    result => { result.samples[0].gpuHealth = null; },
    result => { result.samples[0].gpuHealth = gpuHealthFrom([], null); },
    result => { result.samples[0].completed = false; },
    result => { result.samples[0].readiness.ended = false; },
    result => { result.samples[0].readiness.failed = ['parser.complete']; },
    result => { result.samples[0].readiness.done.pop(); },
    result => { result.samples[0].pageErrors.push('real page failure'); },
    result => { result.samples[1].fixture = result.samples[0].fixture; },
    result => { result.samples.pop(); },
  ]) {
    const result = evidence(); mutate(result);
    assert.throws(() => requireFrameEvidence(result));
  }
});

// A replaced attempt as the spec retains it: a fresh-browser retry after the
// renderer lost and re-created its device (#6993/#7164 hosted SwiftShader).
const contaminatedAttempt = (fixture, attempt) => ({ fixture, attempt, completed: false, error: null,
  readiness: null, readinessError: null, pageErrors: [],
  gpuHealth: gpuHealthFrom(['[WebGPU] Device lost: A valid external Instance reference no longer exists. (reason: unknown)'],
    { 'gpu.devices': 4, 'gpu.deviceReplacements': 3, 'gpu.deviceLost': 3 }) });

test('#6975 a clean fresh-browser attempt is admitted only with every contaminated attempt it replaced retained', () => {
  const result = evidence(), snowdon = result.samples[1];
  snowdon.attempt = MAX_ATTEMPTS;
  result.refusedAttempts = [contaminatedAttempt(snowdon.fixture, 1), contaminatedAttempt(snowdon.fixture, 2)];
  assert.doesNotThrow(() => requireFrameEvidence(result));
});

test('#6975 a retry cannot drop receipts, replace a non-GPU failure, exceed the bound or orphan a refusal', () => {
  for (const [mutate, message] of [
    [result => { result.samples[1].attempt = 2; }, /attempt receipts do not account/],
    [result => { result.samples[1].attempt = 3; result.refusedAttempts = [contaminatedAttempt(result.samples[1].fixture, 2)]; }, /attempt receipts do not account/],
    [result => { result.samples[1].attempt = 2; result.refusedAttempts = [{ ...contaminatedAttempt(result.samples[1].fixture, 1), gpuHealth: gpuHealthFrom([], { 'gpu.devices': 1 }) }]; }, /retained GPU-contaminated/],
    [result => { result.samples[1].attempt = MAX_ATTEMPTS + 1; result.refusedAttempts = [1, 2, 3].map(n => contaminatedAttempt(result.samples[1].fixture, n)); }, /attempt receipts do not account/],
    [result => { result.refusedAttempts = [contaminatedAttempt('Snowdon', 1)]; }, /attempt receipts do not account/],
    [result => { result.refusedAttempts = [contaminatedAttempt('Elsewhere', 1)]; }, /refused attempts for no admitted sample/],
    [result => { delete result.refusedAttempts; }, /missing refused-attempt/],
    [result => { result.samples[0].error = 'Error: orbit rendered frames'; }, /incomplete/],
  ]) {
    const result = evidence(); mutate(result);
    assert.throws(() => requireFrameEvidence(result), message);
  }
});

test('#6975 refuses historical artifacts without health instead of upgrading them to qualified evidence', () => {
  const result = evidence(); result.schema = 1; delete result.samples;
  assert.throws(() => requireFrameEvidence(result), /unsupported/);
});

test('#6975 workflow CLI fails missing and partial evidence and admits full reducer output', () => {
  const directory = mkdtempSync(join(tmpdir(), '6975-frame-admission-'));
  try {
    const path = join(directory, 'frames.json');
    const check = () => spawnSync(process.execPath, [fileURLToPath(new URL('./check-frame-results.mjs', import.meta.url)), path], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(check().status, 1, 'missing artifact must fail');
    const result = evidence(); result.rows = result.rows.filter(row => row.metric === 'frames');
    writeFileSync(path, JSON.stringify(result));
    assert.equal(check().status, 1, 'the old six-group hole must fail through the actual workflow command');
    writeFileSync(path, JSON.stringify(evidence()));
    const run = check(); assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
