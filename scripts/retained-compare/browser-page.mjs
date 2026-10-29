// SPDX-License-Identifier: MPL-2.0
// Served only by the parity harness; one qualified session stays warm across models.
let wasm, api, session, importMs, qualificationMs = 0;
export async function initialize(driverUrl) {
  const started = performance.now();
  wasm = await import('/pkg/ifc-lite.js');
  await wasm.default();
  api = new wasm.IfcAPI(); session = new wasm.RetainedModelSession();
  importMs = performance.now() - started;
  const { RetainedDriver } = await import(driverUrl);
  const qualify = RetainedDriver.prototype.qualify;
  // Observe the real qualification, which the browser controller times inside
  // invoke/productMs (acquireMs only covers synchronous Worker construction).
  RetainedDriver.prototype.qualify = async function (...args) {
    const began = performance.now();
    try { return await qualify.apply(this, args); }
    finally { qualificationMs += performance.now() - began; }
  };
}
const frame = value => ({ needsShift: value.needsShift, rtcOffset: Array.from(value.rtcOffset) });
export async function runModel(model) {
  const bytes = new Uint8Array(await (await fetch(`/source/${model}`)).arrayBuffer());
  let prepass;
  try { prepass = frame(api.buildPrePassOnce(bytes)); }
  finally { api.clearPrePassCache(); }
  const runs = {};
  for (const detail of ['shape', 'view']) {
    const outcomes = [], elapsed = [];
    const qualificationBefore = qualificationMs;
    let start, previous = performance.now(), previousQualification = qualificationMs;
    const summary = await session.run(bytes, { detail }, event => {
      if (event.kind === 'start') {
        start = { candidateIds: Array.from(event.candidateIds), frame: frame(event.frame) };
        previous = performance.now(); return;
      }
      const now = performance.now();
      elapsed.push(Math.max(0, now - previous - (qualificationMs - previousQualification)));
      previous = now; previousQualification = qualificationMs;
      const common = { ...event, status: event.kind };
      delete common.kind;
      if (event.kind === 'published' && detail === 'shape') {
        outcomes.push({ ...common, parts: event.parts.map(part => ({ ...part,
          positions: Array.from(part.positions), indices: Array.from(part.indices), worldFromObject: Array.from(part.worldFromObject) })) });
      } else if (event.kind === 'published') {
        const collection = event.meshes, meshes = [];
        try {
          for (let i = 0; i < collection.length; i++) {
            const mesh = collection.get(i);
            try { meshes.push({ expressId: mesh.expressId, positions: Array.from(mesh.positions), indices: Array.from(mesh.indices),
              origin: Array.from(mesh.origin), rtcOffset: [collection.rtcOffsetX, collection.rtcOffsetY, collection.rtcOffsetZ] }); }
            finally { mesh.free(); }
          }
        } finally { collection.free(); }
        outcomes.push({ ...common, meshes });
      } else outcomes.push(common);
    });
    runs[detail] = { start, outcomes, summary, qualificationMs: qualificationMs - qualificationBefore,
      productWallMs: elapsed, wasmHeapBytes: wasm.get_memory().buffer.byteLength };
  }
  return { ...runs, prepass, importMs };
}
export function dispose() { session?.free(); api?.free(); }
