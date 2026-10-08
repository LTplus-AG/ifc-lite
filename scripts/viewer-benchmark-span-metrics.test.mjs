/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6956: the viewer benchmark reads its timing metrics from the viewer's
// load-trace span tree (window.__IFC_LITE_LOAD_TRACE__) first and falls back
// to the console regexes only for what the tree does not carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { ViewerBenchmarkPage } = await tsImport('../tests/benchmark/viewer-benchmark-page.ts', import.meta.url);
const { metricsFromLoadTrace } = await tsImport('../tests/benchmark/load-trace-metrics.ts', import.meta.url);

// Console lines as the current viewer prints them for one FZK-sized load.
const LOGS = [
  '[useIfc] File: AC20-FZK-Haus.ifc, size: 2.41MB, read in 12ms',
  '[stream] worker[0] first batch @ 90ms (106 meshes)',
  '[useIfc] Data model parsing start for AC20-FZK-Haus.ifc: 40ms (worker)',
  '[useIfc] Spatial tree ready for AC20-FZK-Haus.ifc at 150ms',
  '[useIfc] First appendGeometryBatch for AC20-FZK-Haus.ifc: 180ms',
  '[useIfc] First visible geometry for AC20-FZK-Haus.ifc: 200ms',
  '[useIfc] Data model parsing complete for AC20-FZK-Haus.ifc: 260ms',
  '[useIfc] Geometry streaming complete: 4 batches, 317 meshes',
  '[useIfc] Stream complete for AC20-FZK-Haus.ifc: 300ms',
  '[ifc-lite] AC20-FZK-Haus.ifc (2.4MB) → 230 meshes, 120k verts in 0.4s',
  '[ifc-lite] render stats: 10 draw calls, 1.0 MB GPU resident (10 batches drawn, 0 frustum-culled, 0 contribution-culled)',
];

// The same load as a span tree; every value is a few ms off its console twin
// so the test can tell which source a metric came from.
const SNAPSHOT = {
  loadId: 'm1',
  attrs: { journey: 'J1', modelKind: 'primary' },
  timeOrigin: 0,
  start: 1000,
  end: 1403,
  spans: [
    { id: 0, name: 'file.read', thread: 'main', start: 1001, end: 1014, parentId: null },
    { id: 1, name: 'geometry.pool', thread: 'main', start: 1050, end: 1302, parentId: null },
    { id: 2, name: 'geometry.firstBatch', thread: 'main', start: 1000, end: 1141, parentId: null, milestone: true },
    { id: 3, name: 'parser.start', thread: 'main', start: 1000, end: 1041, parentId: null, milestone: true },
    { id: 4, name: 'parser.spatialReady', thread: 'main', start: 1000, end: 1151, parentId: null, milestone: true },
    { id: 5, name: 'geometry.firstAppend', thread: 'main', start: 1000, end: 1181, parentId: null, milestone: true },
    { id: 6, name: 'geometry.firstVisible', thread: 'main', start: 1000, end: 1201, parentId: null, milestone: true },
    { id: 7, name: 'parser.complete', thread: 'main', start: 1000, end: 1261, parentId: null, milestone: true },
    { id: 8, name: 'geometry.streamComplete', thread: 'main', start: 1000, end: 1301, parentId: null, milestone: true },
    { id: 9, name: 'shard.scan', thread: 'geom-0', start: 1060, end: 1070, parentId: 1 },
  ],
};

function fakePage(snapshot) {
  const listeners = [];
  const initScripts = [];
  return {
    initScripts,
    emit: (text) => { for (const cb of listeners) cb({ text: () => text }); },
    on(event, cb) { if (event === 'console') listeners.push(cb); },
    async addInitScript(fn) { initScripts.push(fn); },
    async goto() {},
    async waitForSelector() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    locator() { return { first() { return { async setInputFiles() {} }; } }; },
    // The span tree is requested by global key, and the completion probe
    // (#6979) runs its real in-page reducer over the same snapshot; every
    // other evaluate is the canvas probe, which reports an allocated canvas.
    async evaluate(fn, arg) {
      if (arg === '__IFC_LITE_LOAD_TRACE__') return snapshot;
      if (arg?.key === '__IFC_LITE_LOAD_TRACE__') {
        const g = globalThis;
        g.__IFC_LITE_LOAD_TRACE__ = { latest: () => snapshot };
        try { return fn(arg); } finally { delete g.__IFC_LITE_LOAD_TRACE__; }
      }
      return true;
    },
  };
}

async function measure(snapshot, timeoutMs = 5_000) {
  const page = fakePage(snapshot);
  const bench = new ViewerBenchmarkPage(page);
  await bench.setup();
  for (const line of LOGS) page.emit(line);
  await bench.loadFile('AC20-FZK-Haus.ifc', false);
  await bench.waitForCompletion(timeoutMs);
  return { page, metrics: bench.getMetrics() };
}

test('#6956 timing metrics come from the load-trace span tree when the viewer exposes one', async () => {
  const { metrics } = await measure(SNAPSHOT);
  assert.deepEqual(
    {
      totalWallClockMs: metrics.totalWallClockMs,
      fileReadMs: metrics.fileReadMs,
      firstBatchWaitMs: metrics.firstBatchWaitMs,
      metadataStartMs: metrics.metadataStartMs,
      spatialReadyMs: metrics.spatialReadyMs,
      firstAppendGeometryBatchMs: metrics.firstAppendGeometryBatchMs,
      firstVisibleGeometryMs: metrics.firstVisibleGeometryMs,
      metadataCompleteMs: metrics.metadataCompleteMs,
      streamCompleteMs: metrics.streamCompleteMs,
      geometryStreamingMs: metrics.geometryStreamingMs,
    },
    {
      totalWallClockMs: 403,
      fileReadMs: 13,
      firstBatchWaitMs: 91, // first batch measured from the pool start, like the [stream] line
      metadataStartMs: 41,
      spatialReadyMs: 151,
      firstAppendGeometryBatchMs: 181,
      firstVisibleGeometryMs: 201,
      metadataCompleteMs: 261,
      streamCompleteMs: 301,
      geometryStreamingMs: 301,
    },
  );
  // Counts the span tree does not carry still come from the console lines.
  assert.equal(metrics.totalMeshes, 317);
  assert.equal(metrics.totalBatches, 4);
  assert.equal(metrics.drawCalls, 10);
});

test('#6956 the benchmark turns the viewer tracer on before the app boots', async () => {
  const { page } = await measure(SNAPSHOT);
  const g = globalThis;
  delete g.__IFC_LITE_PERF_TRACE;
  for (const script of page.initScripts) script();
  assert.equal(g.__IFC_LITE_PERF_TRACE, 1);
  delete g.__IFC_LITE_PERF_TRACE;
});

test('#6956 without a span tree the console regexes still supply every metric', async () => {
  const { metrics } = await measure(null);
  assert.equal(metrics.totalWallClockMs, 400);
  assert.equal(metrics.fileReadMs, 12);
  assert.equal(metrics.firstBatchWaitMs, 90);
  assert.equal(metrics.firstVisibleGeometryMs, 200);
  assert.equal(metrics.streamCompleteMs, 300);
  assert.equal(metrics.metadataCompleteMs, 260);
});

test('#6979 load completion comes from the span tree: an open load root is not complete, whatever the console says', async () => {
  // Every console completion line is present (LOGS); only the root span is still open.
  const { metrics } = await measure({ ...SNAPSHOT, end: null }, 300);
  assert.equal(metrics.canvasHasContent, false);
  assert.equal(metrics.renderCompleteMs, null);
});

test('#6979 an ended load root completes the load', async () => {
  const { metrics } = await measure(SNAPSHOT);
  assert.equal(metrics.canvasHasContent, true);
  assert.equal(typeof metrics.renderCompleteMs, 'number');
});

// #7036 real cache route emits cache.storeReady, not parser.complete.
test('#7036 metadata timing maps the actual cached store milestone only for cache route', () => {
  const cached={loadId:'cached',start:100,end:160,attrs:{loadPath:'cache'},spans:[{name:'cache.storeReady',thread:'main',start:140,end:140,milestone:true}]};
  assert.equal(metricsFromLoadTrace(cached).metadataCompleteMs,40);
  assert.equal(metricsFromLoadTrace({...cached,attrs:{loadPath:'wasm'}}).metadataCompleteMs,undefined);
});

test('#7036 cached readiness runs actual page trace reducer without any parser completion mark', async () => {
  const snapshot = {
    ...SNAPSHOT,
    attrs: { loadPath: 'cache' },
    spans: [
      ...SNAPSHOT.spans.filter(span => !span.name.startsWith('parser.') && span.name !== 'geometry.pool' && span.name !== 'geometry.firstBatch'),
      { name: 'cache.storeReady', thread: 'main', start: 1200, end: 1200, milestone: true },
      { name: 'scene.finalize', thread: 'main', start: 1300, end: 1380 },
    ],
  };
  const page = fakePage(snapshot);
  const bench = new ViewerBenchmarkPage(page);
  await bench.setup();
  await bench.loadFile('cached.ifc', false);
  await bench.waitForCompletion(1000, true);
  assert.equal(bench.getMetrics().metadataCompleteMs, 200);
  assert.equal(bench.getMetrics().streamCompleteMs, 301);
  assert.equal(bench.getMetrics().canvasHasContent, true);
  assert.equal(bench.getMetrics().firstBatchWaitMs, null, 'cached route creates no worker geometry pool');
});
