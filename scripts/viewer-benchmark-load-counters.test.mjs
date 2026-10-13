/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6957: the viewer benchmark pins its geometry worker count and records the
// load's structural counters and long-frame summary in its result JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { runInNewContext } from 'node:vm';

const { ViewerBenchmarkPage } = await tsImport('../tests/benchmark/viewer-benchmark-page.ts', import.meta.url);
const { countersFromLoadTrace } = await tsImport('../tests/benchmark/load-trace-metrics.ts', import.meta.url);

const MAIN_THREAD = {
  supported: { loaf: true, longtask: true },
  loaf: { count: 3, over50: 3, totalMs: 340, blockingMs: 165, longestMs: 200 },
  longtask: { count: 1, over50: 1, totalMs: 190, blockingMs: 140, longestMs: 190 },
  bySpan: { 'load.finalize': { count: 1, blockingMs: 20, durationMs: 80 } },
};

const SNAPSHOT = {
  loadId: 'm1',
  attrs: { journey: 'J1' },
  timeOrigin: 0,
  start: 1000,
  end: 1400,
  spans: [
    { id: 0, name: 'geometry.streamComplete', thread: 'main', start: 1000, end: 1300, parentId: null, milestone: true },
    { id: 1, name: 'parser.complete', thread: 'main', start: 1000, end: 1200, parentId: null, milestone: true },
    // Renderer finalization may finish after the loader root (#7005).
    { id: 2, name: 'scene.finalize', thread: 'main', start: 1390, end: 1450, parentId: null },
  ],
  counters: {
    'msg.geometry.out.count': 12,
    'gpu.uniformWriteBytes': 5120,
    'gpu.buffers': 40,
    'copy.source.sharedSource.bytes': 2_500_000,
    'wasm.bytesIn': 3_000_000,
  },
  workerCounters: { 'geom-0': { 'wasm.bytesIn': 3_000_000 } },
  mainThread: MAIN_THREAD,
};

test('#6993 GPU upload counters become structural only when every observed flush used count mode', () => {
  const flush = (count) => ({ name: 'scene.flushPending', thread: 'main', start: 1000, end: 1001, attrs: count ? { uploadMode: 'count' } : {} });
  const countOnly = countersFromLoadTrace({ ...SNAPSHOT, counters: { ...SNAPSHOT.counters, 'gpu.writeBytes': 128, 'gpu.staticUpload.bytes': 64 }, spans: [flush(true), flush(true)] });
  assert.equal(countOnly.structural['gpu.buffers'], 40);
  assert.equal(countOnly.scheduling['gpu.uniformWriteBytes'], 5120);
  assert.equal(countOnly.scheduling['gpu.writeBytes'], 128, 'mutable writes still depend on update timing');
  assert.equal(countOnly.structural['gpu.staticUpload.bytes'], 64);
  const mixed = countersFromLoadTrace({ ...SNAPSHOT, spans: [flush(true), flush(false)] });
  assert.equal(mixed.scheduling['gpu.buffers'], 40);
  assert.equal(mixed.structural['gpu.buffers'], undefined);
  assert.equal(countersFromLoadTrace({ ...SNAPSHOT, spans: [] }).scheduling['gpu.buffers'], 40);
});

function fakePage(snapshot) {
  const visited = [];
  // Execute the real serialized page callbacks, including span readiness and
  // canvas allocation. Returning `true` for unknown probes hid contract drift.
  const realm = {
    __IFC_LITE_LOAD_TRACE__: {
      latest: () => typeof snapshot === 'function' ? snapshot() : snapshot,
    },
    document: { querySelector: (selector) => selector === 'canvas' ? { width: 800, height: 600 } : null },
  };
  return {
    visited,
    on() {},
    async addInitScript() {},
    async goto(url) { visited.push(url); },
    async waitForSelector() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    locator() { return { first() { return { async setInputFiles() {} }; } }; },
    async evaluate(fn, arg) {
      return runInNewContext(`(${fn.toString()})(argument)`, { ...realm, argument: arg });
    },
  };
}

async function run(snapshot, env) {
  const saved = process.env.VIEWER_BENCHMARK_GEOM_WORKERS;
  if (env === undefined) delete process.env.VIEWER_BENCHMARK_GEOM_WORKERS; else process.env.VIEWER_BENCHMARK_GEOM_WORKERS = env;
  try {
    const page = fakePage(snapshot);
    const bench = new ViewerBenchmarkPage(page, 'http://bench');
    await bench.setup();
    await bench.loadFile('AC20-FZK-Haus.ifc', false);
    await bench.waitForCompletion(1_000);
    await bench.settleLoadCounters?.({ pollMs: 0 });
    return { visited: page.visited, recorded: bench.getLoadCounters?.() };
  } finally {
    if (saved === undefined) delete process.env.VIEWER_BENCHMARK_GEOM_WORKERS; else process.env.VIEWER_BENCHMARK_GEOM_WORKERS = saved;
  }
}

test('#6957 the benchmark pins four geometry workers by default through ?geomWorkers', async () => {
  const { visited } = await run(SNAPSHOT, undefined);
  assert.deepEqual(visited, ['http://bench/?geomWorkers=4']);
  assert.deepEqual((await run(SNAPSHOT, '2')).visited, ['http://bench/?geomWorkers=2']);
  assert.deepEqual((await run(SNAPSHOT, 'auto')).visited, ['http://bench']);
});

test('#6957 the result records repeatable structural counters apart from scheduling-dependent ones', async () => {
  const { recorded } = await run(SNAPSHOT, undefined);
  assert.deepEqual(recorded, {
    geomWorkers: 4,
    counters: {
      structural: {
        'copy.source.sharedSource.bytes': 2_500_000,
        'msg.geometry.out.count': 12,
        'wasm.bytesIn': 3_000_000,
      },
      scheduling: { 'gpu.buffers': 40, 'gpu.uniformWriteBytes': 5120 },
      workerCounters: { 'geom-0': { 'wasm.bytesIn': 3_000_000 } },
      mainThread: MAIN_THREAD,
    },
  });
});

test('#6957 a viewer without counters records null rather than an empty, healthy-looking block', async () => {
  const { recorded } = await run({ ...SNAPSHOT, counters: undefined, workerCounters: undefined, mainThread: undefined }, 'auto');
  assert.deepEqual(recorded, { geomWorkers: null, counters: null });
});

test('#6957 counters are recorded once they stop moving, not at the load root\'s end', async () => {
  // Deferred GPU uploads land after the load root ends: the first reads still grow.
  let reads = 0;
  const growing = () => {
    reads++;
    const buffers = Math.min(reads, 5) * 10;
    // Per-frame uniform writes never stop growing and must not hold the wait open.
    return { ...SNAPSHOT, counters: { 'gpu.buffers': buffers, 'gpu.uniformWriteBytes': reads * 64 } };
  };
  const { recorded } = await run(growing, undefined);
  assert.equal(recorded.counters.scheduling['gpu.buffers'], 50);
});


test('#7005 counter collection rejects a failed renderer span despite complete geometry and healthy counters', async () => {
  const failed = {
    ...SNAPSHOT,
    spans: SNAPSHOT.spans.map(span => span.name === 'scene.finalize'
      ? { ...span, end: null, attrs: { error: true } }
      : span),
  };
  await assert.rejects(run(failed, undefined), /Renderer failed before metadata\/render readiness/);
});
