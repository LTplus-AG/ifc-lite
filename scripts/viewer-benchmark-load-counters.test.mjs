/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6957: the viewer benchmark pins its geometry worker count and records the
// load's structural counters and long-frame summary in its result JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { ViewerBenchmarkPage } = await tsImport('../tests/benchmark/viewer-benchmark-page.ts', import.meta.url);

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
  spans: [{ id: 0, name: 'geometry.streamComplete', thread: 'main', start: 1000, end: 1300, parentId: null, milestone: true }],
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

function fakePage(snapshot) {
  const visited = [];
  return {
    visited,
    on() {},
    async addInitScript() {},
    async goto(url) { visited.push(url); },
    async waitForSelector() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    locator() { return { first() { return { async setInputFiles() {} }; } }; },
    async evaluate(_fn, arg) {
      if (arg !== '__IFC_LITE_LOAD_TRACE__') return true;
      return typeof snapshot === 'function' ? snapshot() : snapshot;
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
