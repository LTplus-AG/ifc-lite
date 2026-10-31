/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Served by retained-qual-browser-memory.mjs only. One FRESH page runs one model through
// the real `RetainedModelSession` (detail 'view', the viewer's own detail), tallies
// events without retaining geometry, and samples what the page can see of memory:
// the retained WASM linear memory (`get_memory().buffer.byteLength`, observed at module
// load, at every product event and at the end: a maximum OBSERVED, not an exact peak),
// `performance.memory` where Chrome offers it, and the worker-inclusive
// `measureUserAgentSpecificMemory`. The SDK's own Worker linear heap is private; this
// module never fabricates it.
let wasm, session, importMs;

const uaMemory = async () => {
  if (!globalThis.crossOriginIsolated) return { bytes: null, reason: 'page is not cross-origin isolated' };
  if (!performance.measureUserAgentSpecificMemory) return { bytes: null, reason: 'measureUserAgentSpecificMemory unavailable' };
  try { const m = await performance.measureUserAgentSpecificMemory(); return { bytes: m.bytes }; }
  catch (error) { return { bytes: null, reason: String(error) }; }
};
const jsHeap = () => (performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null);

export async function initialize() {
  const started = performance.now();
  wasm = await import('/pkg/ifc-lite.js');
  await wasm.default();
  session = new wasm.RetainedModelSession();
  importMs = performance.now() - started;
}

export async function runModel(modelUrl) {
  const errors = [];
  const bytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
  const wasmHeapStartBytes = wasm.get_memory().buffer.byteLength;
  const uaBefore = await uaMemory(), jsBefore = jsHeap();
  const tally = { published: 0, refused: 0, meshes: 0 };
  let startCandidates = null, started = false, wasmHeapMaxObservedBytes = wasmHeapStartBytes;
  const began = performance.now();
  let summary;
  try {
    summary = await session.run(bytes, { detail: 'view' }, event => {
      if (event.kind === 'start') { started = true; startCandidates = event.candidateIds.length; }
      else if (event.kind === 'published') {
        tally.published++;
        const collection = event.meshes;
        try { tally.meshes += collection.length; } finally { collection.free(); }
      } else tally.refused++;
      wasmHeapMaxObservedBytes = Math.max(wasmHeapMaxObservedBytes, wasm.get_memory().buffer.byteLength);
    });
  } catch (error) { errors.push(String(error)); }
  const runMs = performance.now() - began;
  const wasmHeapEndBytes = wasm.get_memory().buffer.byteLength;
  wasmHeapMaxObservedBytes = Math.max(wasmHeapMaxObservedBytes, wasmHeapEndBytes);
  const uaAfter = await uaMemory(), jsAfter = jsHeap();
  return { started, startCandidates, summary: summary ?? null, tally, errors, importMs, runMs, sourceBytes: bytes.byteLength,
    wasmHeapStartBytes, wasmHeapMaxObservedBytes, wasmHeapEndBytes, uaBefore, uaAfter, jsBefore, jsAfter,
    crossOriginIsolated: globalThis.crossOriginIsolated };
}

export function dispose() { session?.free(); }
