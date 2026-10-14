/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6993 native count driver: the browser-free verdict, query and receipt
// logic, plus ViewerBenchmarkPage's exact-query/count entry points driven
// through a recording page. Synthetic traces only: never native evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  assessCountSample, decodeCountQuery, fixtureReceipt, nativeCountPlan, summarizeCountSamples,
  NATIVE_COUNT_QUERY, type SampleObservation,
} from './native-count-evidence.js';
import { gpuHealthFrom } from '../../tests/benchmark/gpu-health.js';
import { ViewerBenchmarkPage } from '../../tests/benchmark/viewer-benchmark-page.js';
import type { LoadTraceSnapshotJson } from '../../tests/benchmark/load-trace-metrics.js';

const span = (name: string, attrs?: Record<string, unknown>, end: number | null = 50) => ({ name, thread: 'main', start: 1, end, attrs });
function trace(overrides: Partial<LoadTraceSnapshotJson> = {}, buffers = 701): LoadTraceSnapshotJson {
  return {
    loadId: 'l', attrs: { loadPath: 'wasm' }, start: 0, end: 100,
    spans: [span('parser.complete'), span('geometry.streamComplete'), span('scene.flushPending', { uploadMode: 'count' }),
      span('scene.finalize', { batches: 15, fragments: 203 }, 120)],
    counters: { 'gpu.buffers': buffers, 'gpu.bufferBytes': 27969768, 'gpu.staticUpload.count': 452, 'gpu.staticUpload.bytes': 1283640,
      'msg.worker.out.transferBytes': 2598250, 'msg.geometry.out.transferBytes': 10, 'gpu.writeBytes': 9 },
    ...overrides,
  };
}
const healthy = (): SampleObservation => ({
  trace: trace(), countersSettled: true, gpuHealth: gpuHealthFrom([], { 'gpu.devices': 1, 'gpu.deviceReplacements': 0 }),
  pageErrors: [], interactionErrors: {}, refusals: [],
});

test('#6993 the literal acceptance query decodes to the pinned count cohort', () => {
  assert.deepEqual(decodeCountQuery(NATIVE_COUNT_QUERY), {
    perfTrace: 1, geomWorkers: 4, meshCache: 0, benchmarkUploads: 1, batchSizing: { targetMs: 8000, minJobs: 64, maxJobs: 64 },
  });
  const plan = nativeCountPlan('http://127.0.0.1:9');
  assert.deepEqual(plan.map((s) => `${s.fixture}${s.iteration}`), ['FZK1', 'FZK2', 'Snowdon1', 'Snowdon2']);
  assert.ok(plan.every((s) => s.url === `http://127.0.0.1:9/${NATIVE_COUNT_QUERY}` && !s.url.includes('model=')));
});

test('#6993 a query that is not a pinned count cohort is refused', () => {
  const sizing = (json: string) => `?perfTrace=1&geomWorkers=4&meshCache=0&perf.benchmarkUploads=1&perf.batchSizing=${encodeURIComponent(json)}`;
  for (const [query, reason] of [
    [NATIVE_COUNT_QUERY.slice(1), /start with/],
    [NATIVE_COUNT_QUERY.replace('meshCache=0', 'meshCache=1'), /meshCache must be 0/],
    [NATIVE_COUNT_QUERY.replace('perf.benchmarkUploads=1', 'perf.benchmarkUploads=0'), /benchmarkUploads must be 1/],
    [NATIVE_COUNT_QUERY.replace('geomWorkers=4', 'geomWorkers=auto'), /geomWorkers/],
    [NATIVE_COUNT_QUERY.replace('&meshCache=0', ''), /meshCache exactly once/],
    [`${NATIVE_COUNT_QUERY}&perfTrace=1`, /perfTrace exactly once/],
    [`${NATIVE_COUNT_QUERY}&model=/x.ifc`, /unexpected query parameter/],
    [sizing('{"targetMs":8000,"minJobs":64,"maxJobs":512}'), /minJobs === maxJobs/],
    [sizing('{"targetMs":8000,"minJobs":64}'), /maxJobs must be a positive integer/],
    [sizing('nope'), /not JSON/],
  ] as const) assert.throws(() => decodeCountQuery(query), reason, query);
});

test('#6993 a sample with every witness is healthy and records both vectors', () => {
  const verdict = assessCountSample(healthy());
  assert.deepEqual(verdict.refusals, []);
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.gpuVector, { 'gpu.buffers': 701, 'gpu.bufferBytes': 27969768, 'gpu.staticUpload.count': 452, 'gpu.staticUpload.bytes': 1283640 });
  assert.deepEqual(verdict.transferVector, { 'msg.geometry.out.transferBytes': 10, 'msg.worker.out.transferBytes': 2598250 });
  assert.deepEqual(verdict.finalize, { batches: 15, fragments: 203 });
  // A canonical cache load witnesses metadata by cache.storeReady instead.
  const cached = trace({ attrs: { loadPath: 'cache' } });
  cached.spans[0] = span('cache.storeReady');
  assert.equal(assessCountSample({ ...healthy(), trace: cached }).healthy, true);
  assert.match(assessCountSample({ ...healthy(), trace: { ...cached, spans: [span('parser.complete'), ...cached.spans.slice(1)] } }).refusals.join(), /cache.storeReady not finished/);
});

test('#6993 each missing or contaminating witness refuses the sample by name', () => {
  const without = (name: string) => trace({ spans: trace().spans.filter((s) => s.name !== name) });
  const unfinished = (name: string) => trace({ spans: trace().spans.map((s) => (s.name === name ? { ...s, end: null } : s)) });
  const cases: [Partial<SampleObservation>, RegExp][] = [
    [{ trace: null }, /no load trace/],
    [{ trace: without('parser.complete') }, /parser.complete not finished/],
    [{ trace: unfinished('geometry.streamComplete') }, /geometry.streamComplete not finished/],
    [{ trace: trace({ end: null }) }, /root span not ended/],
    [{ trace: unfinished('scene.finalize') }, /scene.finalize not finished/],
    [{ trace: trace({ spans: [...trace().spans, span('parser.failed')] }) }, /failed spans: parser.failed/],
    [{ trace: trace({ spans: trace().spans.map((s) => (s.name === 'scene.flushPending' ? { ...s, attrs: { uploadMode: 'timed' } } : s)) }) }, /outside count upload mode/],
    [{ trace: without('scene.flushPending') }, /no scene.flushPending/],
    [{ trace: trace({ counters: { 'msg.worker.out.transferBytes': 1 } }) }, /vector incomplete/],
    [{ trace: trace({ counters: { ...trace().counters, 'msg.worker.out.transferBytes': undefined as unknown as number, 'msg.geometry.out.transferBytes': undefined as unknown as number } }) }, /no sender transfer/],
    [{ countersSettled: false }, /did not settle/],
    [{ gpuHealth: null }, /GPU health not read/],
    [{ gpuHealth: gpuHealthFrom(['[WebGPU] Device lost: x (reason: unknown)'], { 'gpu.devices': 1, 'gpu.deviceReplacements': 0 }) }, /device lost 1x/],
    [{ gpuHealth: gpuHealthFrom([], { 'gpu.devices': 2, 'gpu.deviceReplacements': 1 }) }, /device replaced 1x/],
    [{ gpuHealth: gpuHealthFrom([], null) }, /replacement unwitnessed/],
    [{ pageErrors: ['TypeError: boom'] }, /1 page error/],
    [{ interactionErrors: { hover: 'covered' } }, /interaction hover not measured: covered/],
    [{ refusals: ['host post-admission refused'] }, /host post-admission refused/],
  ];
  for (const [patch, reason] of cases) {
    const verdict = assessCountSample({ ...healthy(), ...patch });
    assert.equal(verdict.healthy, false, String(reason));
    assert.match(verdict.refusals.join('; '), reason);
  }
});

test('#6993 repeat is judged over healthy samples only, both vectors exactly', () => {
  const sample = (fixture: string, observation: SampleObservation) => ({ fixture, verdict: assessCountSample(observation) });
  const [fzk, snowdon] = summarizeCountSamples([
    sample('FZK', healthy()), sample('FZK', healthy()),
    sample('Snowdon', healthy()), sample('Snowdon', { ...healthy(), trace: trace({}, 702) }),
  ]);
  assert.equal(fzk.repeat, true);
  assert.equal(snowdon.repeat, false);
  // An unhealthy sample never pools in, so one healthy load is no verdict.
  const [partial] = summarizeCountSamples([sample('FZK', healthy()), sample('FZK', { ...healthy(), pageErrors: ['x'] })]);
  assert.deepEqual([partial.samples, partial.healthy, partial.repeat], [2, 1, null]);
});

test('#6993 fixture receipts hash the bytes and refuse a manifest mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-count-'));
  try {
    mkdirSync(join(root, 'tests/models/various'), { recursive: true });
    const bytes = Buffer.from('ISO-10303-21;');
    writeFileSync(join(root, 'tests/models/various/a.ifc'), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fixture = { key: 'A', path: 'tests/models/various/a.ifc' };
    assert.deepEqual(fixtureReceipt(root, fixture, { files: [{ path: 'various/a.ifc', sha256 }] }), { ...fixture, sha256, manifestSha256: sha256 });
    assert.throws(() => fixtureReceipt(root, fixture, { files: [{ path: 'various/a.ifc', sha256: '0'.repeat(64) }] }), /does not match manifest/);
    assert.throws(() => fixtureReceipt(root, fixture, { files: [] }), /does not match manifest null/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A page that records navigation and init scripts; selectors resolve at once. */
function recordingPage() {
  const calls = { goto: [] as string[], initScripts: 0, files: [] as unknown[] };
  const page = {
    on: () => page,
    goto: async (url: string) => { calls.goto.push(url); },
    waitForSelector: async () => null,
    addInitScript: async () => { calls.initScripts++; },
    locator: () => ({ first: () => ({ setInputFiles: async (file: unknown) => { calls.files.push(file); } }) }),
  };
  return { page: page as unknown as Page, calls };
}

test('#6993 exact-query setup navigates to the literal query and applies no global', async () => {
  const { page, calls } = recordingPage();
  const viewer = new ViewerBenchmarkPage(page, 'http://o');
  await viewer.setup({ query: NATIVE_COUNT_QUERY });
  assert.deepEqual(calls.goto, [`http://o/${NATIVE_COUNT_QUERY}`]);
  assert.equal(calls.initScripts, 0, 'a global would shadow the URL flag');
  assert.equal(viewer.getUploadMode(), 'count');
  assert.equal(viewer.getLoadCounters().geomWorkers, 4);
  // Timing callers keep refusing count mode, before any upload happens.
  await assert.rejects(viewer.loadUntilReady('/x.ifc', 1), /not a timing workload/);
  assert.deepEqual(calls.files, []);
  await assert.rejects(new ViewerBenchmarkPage(recordingPage().page).setup({ query: '?geomWorkers=4' }), /perfTrace=1/);
});

test('#6993 the count entry point refuses a timed setup before uploading', async () => {
  const { page, calls } = recordingPage();
  const viewer = new ViewerBenchmarkPage(page, 'http://o');
  await viewer.setup({ query: '?perfTrace=1&geomWorkers=4' });
  const payload = { name: 'a.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from('x') };
  await assert.rejects(viewer.loadUntilCountReady(payload, 1), /needs a count-upload setup/);
  assert.deepEqual(calls.files, []);
});
