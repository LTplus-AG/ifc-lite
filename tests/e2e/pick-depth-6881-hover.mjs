/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6881: passive timing/allocation tap; never appends oracle GPU work.
import { mountedRenderer } from './pick-depth-6881-observer.mjs';

// FederatedModel.loadState is optional: the completed non-streaming add
// publishes a parsed store without that field (as the viewer's Flow loader does).
const completeModel = model => !!model.ifcDataStore && !!model.geometryResult && !model.loadError
  && (model.loadState === undefined || model.loadState === 'complete');

/** Actual publication plus resident batches for these public mesh fixtures. */
export function capturePublication(expectedModels) {
  const state = globalThis.__ifc_lite_viewer_store__?.getState();
  const canvas = document.querySelector('canvas[data-viewport="main"]');
  if (!state || !canvas || state.models.size !== expectedModels) return { ready: false, modelCount: state?.models.size };
  const renderer = mountedRenderer(canvas), scene = renderer.getScene();
  const frame = renderer.getFrameStats();
  const modelIndices = [...new Set(scene.getBatchedMeshes().filter(batch => batch.indexCount > 0)
    .flatMap(batch => batch.modelIndices ?? [0]).map(index => index ?? 0))];
  const observation = { modelCount: state.models.size, metadataComplete: [...state.models.values()].every(completeModel),
    loading: state.loading, streaming: state.geometryStreamingActive, error: state.error,
    queuedMeshes: scene.hasQueuedMeshes(), modelIndices, drawCalls: frame.drawCalls, batchesNotResident: frame.batchesNotResident,
    canvas: { width: canvas.width, height: canvas.height } };
  return { ...observation, ready: observation.metadataComplete && !observation.loading && !observation.streaming && !observation.error
    && !observation.queuedMeshes && modelIndices.length === expectedModels && observation.drawCalls > 0
    && observation.batchesNotResident === 0 && canvas.width > 0 && canvas.height > 0 && !!renderer.getGPUDevice() };
}

export async function geometryWitness() {
  const state = globalThis.__ifc_lite_viewer_store__.getState();
  if (state.loading || state.geometryStreamingActive || !state.models.size) throw Error('Incomplete publication');
  const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
  const normalize = async value => {
    if (value === undefined) return { kind: 'undefined' };
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return { kind: 'bigint', value: value.toString() };
    if (typeof value === 'number') return { kind: 'float64', sha256: await hash(new Float64Array([value])) };
    if (ArrayBuffer.isView(value)) return { kind: value.constructor.name, bytes: value.byteLength,
      sha256: await hash(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    if (value instanceof Map) {
      const entries = [];
      for (const [key, item] of value) entries.push([await normalize(key), await normalize(item)]);
      return { kind: 'map', entries: entries.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(normalize));
    if (Object.getPrototypeOf(value) !== Object.prototype) throw Error('Unsupported geometry field type');
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = await normalize(value[key]);
    return result;
  };
  const results = [];
  for (const model of state.models.values()) {
    if (!completeModel(model)) throw Error('Incomplete model');
    const result = model.geometryResult;
    const normalized = await normalize(result);
    // Worker completion can reorder publication. Preserve every mesh field
    // and typed-array byte, while comparing the complete mesh multiset.
    normalized.meshes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    results.push({ idOffset: model.idOffset, meshes: result.meshes.length, vertices: result.totalVertices,
      triangles: result.totalTriangles, sha256: await hash(new TextEncoder().encode(JSON.stringify(normalized))) });
  }
  return { scope: 'Complete GeometryResult fields/typed arrays, canonical mesh multiset, coordinate information and instance hash/bounds maps; not publication order or raw GPU buffers', results };
}

export function installHoverTap() {
  if (globalThis.__6881Hover || globalThis.__6881) throw Error('Another pick observer owns this document');
  const canvas = document.querySelector('canvas[data-viewport="main"]'), renderer = mountedRenderer(canvas);
  const picker = renderer.picker, device = renderer.getGPUDevice();
  const store = globalThis.__ifc_lite_viewer_store__;
  const originalPick = picker.pick, originalCreate = device.createBuffer;
  const inputs = [], picks = [], pending = new Set();
  let input = null, allocating = null;
  const listener = event => {
    input = { ts: performance.now(), x: event.clientX, y: event.clientY, commits: [] };
    inputs.push(input);
  };
  canvas.addEventListener('pointermove', listener, true);
  const unsubscribe = store.subscribe((state, previous) => {
    if (input && state.hoverState !== previous.hoverState) input.commits.push({ ms: performance.now() - input.ts,
      entityId: state.hoverState.entityId, modelIndex: state.hoverState.modelIndex, worldXYZ: state.hoverState.worldXYZ });
  });
  const create = function(descriptor) {
    const buffer = originalCreate.call(this, descriptor);
    if (allocating) {
      const row = allocating, map = buffer.mapAsync;
      row.allocations.push({ size: buffer.size, usage: buffer.usage });
      buffer.mapAsync = function(...args) {
        const start = performance.now();
        return map.apply(this, args).then(value => {
          row.maps.push({ size: this.size, ms: performance.now() - start });
          return value;
        });
      };
    }
    return buffer;
  };
  device.createBuffer = create;
  const pick = async function(...args) {
    const snapshot = args[10];
    const row = { input: inputs.indexOf(input), start: performance.now(), allocations: [], maps: [],
      texelInput: args.slice(0, 4), matrix: Array.from(snapshot ? snapshot.getViewProjection().m : args[5]),
      cameraWorld: snapshot ? Array.from(snapshot.getCameraWorld()) : null };
    let operation;
    allocating = row;
    try { operation = originalPick.apply(this, args); } finally { allocating = null; }
    pending.add(operation);
    try { row.result = await operation; row.ms = performance.now() - row.start; return row.result; }
    catch (error) { row.error = String(error); throw error; }
    finally { pending.delete(operation); picks.push(row); }
  };
  picker.pick = pick;
  const api = {
    async take() {
      await Promise.all(pending);
      const result = { inputs: inputs.splice(0), picks: picks.splice(0) };
      input = null;
      return result;
    },
    async retire() {
      await Promise.allSettled(pending);
      unsubscribe(); canvas.removeEventListener('pointermove', listener, true);
      if (picker.pick === pick) picker.pick = originalPick;
      if (device.createBuffer === create) device.createBuffer = originalCreate;
      if (globalThis.__6881Hover === api) delete globalThis.__6881Hover;
      return { pending: pending.size };
    },
  };
  globalThis.__6881Hover = api;
  return { installed: true };
}
