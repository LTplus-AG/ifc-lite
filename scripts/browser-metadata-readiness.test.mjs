/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { waitForMetadataRenderReadiness, probePageLoadTrace, READINESS_SPANS } = await tsImport('../tests/benchmark/metadata-render-readiness.ts', import.meta.url);

/**
 * #6979: readiness comes from the load-trace spans. Each event lands at `at`
 * ms as a finished span (the probe the page returns), and, for the legacy
 * scenarios only, as the console line older viewer builds printed instead.
 */
function scenario({ metadataAt = 265, rendererAt = 200, canvasAt = 200, failedAt = Infinity, finalizeError = false, legacy = false, loadPath = 'wasm', metadataSpan = 'parser.complete', metadataError = false } = {}) {
  let now = 0;
  const done = new Set();
  const logs = [];
  const events = [
    [194, 'geometry.streamComplete', '[useIfc] Stream complete for fixture.ifc: 194ms'],
    [200, null, '[ifc-lite] fixture.ifc (2.4MB) → 10 meshes, 20k verts in 0.2s'],
    [rendererAt, 'scene.finalize', '[GeomStream] finalizeStreamingAsync complete: 10ms → 2 consolidated batches'],
    [metadataAt, metadataSpan, '[useIfc] Data model parsing complete for fixture.ifc: 265ms'],
    [failedAt, 'parser.failed', '[useIfc] Data model parsing failed for fixture.ifc: 250ms'],
  ];
  return {
    trace: async () => legacy ? null : {
      ended: now >= 200, loadPath,
      done: [...done],
      failed: [...(finalizeError && done.has('scene.finalize') ? ['scene.finalize'] : []), ...(metadataError && done.has(metadataSpan) ? [metadataSpan] : [])],
    },
    logs: () => logs,
    now: () => now,
    canvasReady: async () => now >= canvasAt,
    pause: async () => {
      now += 5;
      for (const [at, span, line] of events) {
        if (at > now) continue;
        if (span) done.add(span);
        if (legacy && !logs.includes(line)) logs.push(line);
      }
    },
    timeoutMs: 1000,
  };
}

test('#3978 early 200ms renderer finalize cannot complete before 265ms metadata', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario()), 265);
});
test('#3978 delayed metadata moves observed readiness without changing renderer finalize', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ metadataAt: 765 })), 765);
});
test('#3978 metadata alone cannot precede renderer finalization and allocated canvas', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ rendererAt: 350, canvasAt: 450 })), 450);
});
test('#3978 absent metadata fails finitely instead of archiving a successful partial load', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ metadataAt: Infinity })), /Timed out/);
});
test('#3978 metadata failure is retained as failure even after geometry and canvas', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ failedAt: 250 })), /Metadata failed/);
});
test('#3978 an ended load root and allocated canvas cannot substitute for renderer finalization', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ rendererAt: Infinity })), /Timed out/);
});
test('#3978 renderer initialization failure rejects an otherwise ready model', async () => {
  const input = scenario();
  input.logs = () => ['[Viewport] Renderer init failed: Failed to get GPU adapter'];
  await assert.rejects(waitForMetadataRenderReadiness(input), /Renderer failed/);
});

test('#6979 readiness reads the spans: console completion lines alone do not complete a traced load', async () => {
  const input = scenario({ metadataAt: Infinity });
  // The console claims the whole load finished; the span tree, which the page exposes, has no metadata.
  input.logs = () => [
    '[useIfc] Stream complete for fixture.ifc: 194ms',
    '[GeomStream] finalizeStreamingAsync complete: 10ms → 2 consolidated batches',
    '[useIfc] Data model parsing complete for fixture.ifc: 265ms',
  ];
  await assert.rejects(waitForMetadataRenderReadiness(input), /Timed out/);
});
test('#6979 a scene.finalize span that ended in error fails readiness', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ finalizeError: true })), /Renderer failed/);
});

// TODO(remove-by: first release after 2026-10-06, #7005): builds without a load trace.
test('#6979 legacy fallback: a page without a load trace still completes from console lines', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ legacy: true })), 265);
});
test('#6979 legacy fallback: console metadata failure still fails a page without a load trace', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ legacy: true, failedAt: 250 })), /Metadata failed/);
});

// #7036: cache restores the actual store and emits cache.storeReady; no parser runs.
test('#7036 cached metadata completes through actual cache.storeReady route', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({loadPath:'cache',metadataSpan:'cache.storeReady'})),265);
});
test('#7036 cached store readiness still waits for actual scene finalization and canvas', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({loadPath:'cache',metadataSpan:'cache.storeReady',rendererAt:350,canvasAt:200})),350);
});
// #7180: stale console completion cannot certify the current traced load.
for (const loadPath of ['wasm', 'cache']) {
  test(`#7180 ${loadPath} probe needs its own scene.finalize despite a stale renderer log`, async () => {
    const options = { loadPath, metadataSpan: loadPath === 'cache' ? 'cache.storeReady' : 'parser.complete', canvasAt: 0 };
    const incomplete = scenario({ ...options, rendererAt: Infinity });
    incomplete.logs = () => ['[GeomStream] finalizeStreamingAsync complete: 10ms → 2 consolidated batches'];
    await assert.rejects(waitForMetadataRenderReadiness(incomplete), /Timed out/);
    const completed = scenario({ ...options, rendererAt: 550 });
    completed.logs = incomplete.logs;
    assert.equal(await waitForMetadataRenderReadiness(completed), 550);
  });
}

test('#7036 fresh parse cannot substitute a cache store marker for parser.complete', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({metadataSpan:'cache.storeReady'})),/Timed out/);
});
test('#7036 cached route cannot substitute parser.complete for cache.storeReady', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({loadPath:'cache'})),/Timed out/);
});
test('#7036 failed cache store reconstruction refuses metadata readiness', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({loadPath:'cache',metadataSpan:'cache.storeReady',metadataError:true})),/Metadata failed/);
});

test('#7036 actual geometry stream error refuses both fresh and cache readiness', async () => {
  for(const loadPath of ['wasm','cache']){
    const input=scenario({loadPath,metadataSpan:loadPath==='cache'?'cache.storeReady':'parser.complete'});
    const original=input.trace;input.trace=async()=>{const state=await original();return {...state,failed:state.done.includes('geometry.streamComplete')?['geometry.streamComplete']:[]};};
    await assert.rejects(waitForMetadataRenderReadiness(input),/Geometry failed/);
  }
});

// Execute the exact callback passed to page.evaluate against the canonical
// recorder, then consume that projection through readiness (#7180).
const { createLoadTracer } = await tsImport('../packages/load-trace/src/load-trace.ts', import.meta.url);
for (const failure of ['parser.failed', 'worker.scan']) {
  test(`#7180 page callback preserves unfinished ${failure} before readiness filtering`, async () => {
    const key = `__7180_probe_${failure}`;
    const tracer = createLoadTracer({ enabled: true, now: () => 20, sink: null, counters: null });
    const trace = tracer.startLoad('failed-load', { loadPath: 'wasm' }, 0);
    for (const name of ['parser.complete', 'geometry.streamComplete', 'scene.finalize']) trace.milestone(name, 10);
    trace.begin(failure, failure === 'parser.failed' ? undefined : { error: true });
    globalThis[key] = tracer;
    try {
      const input = scenario();
      input.trace = async () => probePageLoadTrace({ key, names: READINESS_SPANS });
      await assert.rejects(waitForMetadataRenderReadiness(input), failure === 'parser.failed' ? /Metadata failed/ : /Load failed.*worker.scan/);
    } finally {
      delete globalThis[key];
    }
  });
}
test('#7180 page callback allows ordinary unfinished work without waiting for root finish', async () => {
  const key = '__7180_probe_ordinary';
  const tracer = createLoadTracer({ enabled: true, now: () => 20, sink: null, counters: null });
  const trace = tracer.startLoad('ready-load', { loadPath: 'wasm' }, 0);
  for (const name of ['parser.complete', 'geometry.streamComplete', 'scene.finalize']) trace.milestone(name, 10);
  trace.begin('worker.scan');
  globalThis[key] = tracer;
  try {
    const input = scenario({ canvasAt: 0 });
    input.trace = async () => probePageLoadTrace({ key, names: READINESS_SPANS });
    const elapsed = input.now;
    input.now = () => 20 + elapsed();
    assert.equal(await waitForMetadataRenderReadiness(input), 20);
    assert.equal(probePageLoadTrace({ key, names: READINESS_SPANS }).ended, false);
  } finally {
    delete globalThis[key];
  }
});
