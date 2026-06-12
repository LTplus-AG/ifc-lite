/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { initSync, IfcAPI } from '@ifc-lite/wasm';
import type { MeshData, TessellationQuality } from './types.js';

export interface GeometryWorkerInitMessage {
  type: 'init';
  wasmModule?: WebAssembly.Module;
  /**
   * Explicit URL to the wasm-bindgen `.wasm` binary. When provided,
   * `init(wasmUrl)` is called instead of relying on wasm-bindgen's
   * default `import.meta.url`-based resolution.
   *
   * Why: consumers whose bundler doesn't transform
   * `new URL('ifc-lite_bg.wasm', import.meta.url)` inside the worker's
   * dist (or who serve the wasm from a CDN at a different origin than
   * the worker) need to resolve the URL on the main thread and pass it
   * in. Default-undefined preserves the wasm-bindgen built-in path so
   * Vite/webpack/Rollup consumers that already work keep working.
   */
  wasmUrl?: string;
}

/**
 * The host sends `stream-start` once with the session metadata (minus
 * jobs), then any number of `stream-chunk` messages with new job slices,
 * and finally `stream-end` to trigger the worker's `complete` + `memory`
 * emit.
 *
 * Used by the streaming pre-pass path so workers can begin processing
 * jobs the moment the first chunk arrives from Rust, rather than waiting
 * for the entire pre-pass to finish.
 */
export interface GeometryWorkerStreamStartMessage {
  type: 'stream-start';
  sharedBuffer: SharedArrayBuffer;
  unitScale: number;
  rtcX: number; rtcY: number; rtcZ: number;
  needsShift: boolean;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  /** Prepass-resolved plane-angle→radians scale (meta event). Seeds each
   *  batch decoder so arc tessellation never re-pays an O(file) scan. */
  planeAngleToRadians?: number;
  /** #407/#913 §2.3 per-element material colour lists (flat encoding) —
   *  drive the transparent/opaque sub-mesh alternation. */
  materialElementIds?: Uint32Array;
  materialColorCounts?: Uint32Array;
  materialColors?: Uint8Array;
}

export interface GeometryWorkerStreamChunkMessage {
  type: 'stream-chunk';
  jobsFlat: Uint32Array;
}

export interface GeometryWorkerStreamEndMessage {
  type: 'stream-end';
}

/**
 * Update the active session's style/void arrays mid-stream. Used when the
 * streaming pre-pass emits its `styles` event AFTER processing has already
 * begun: workers initially process with empty styles (default per-type
 * colours) and switch to resolved styles for any subsequent batches.
 */
export interface GeometryWorkerSetStylesMessage {
  type: 'set-styles';
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  /** #407/#913 §2.3 material colour lists (streamed `styles` event). */
  materialElementIds?: Uint32Array;
  materialColorCounts?: Uint32Array;
  materialColors?: Uint8Array;
}

/**
 * Install a pre-built entity index into the worker's IfcAPI. The streaming
 * pre-pass exports its already-built entity_index after the scan; without
 * this, every process worker would re-scan the entire file (~5 s on a 1 GB
 * IFC) on its first `processGeometryBatch` call. With this, the worker
 * pays ~1 s to build the FxHashMap from the input slices and skips the
 * file scan entirely.
 */
export interface GeometryWorkerSetEntityIndexMessage {
  type: 'set-entity-index';
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
}

export interface GeometryWorkerPrePassMessage {
  type: 'prepass-streaming';
  sharedBuffer: SharedArrayBuffer;
  /** Jobs per chunk (defaults to 50_000). */
  chunkSize?: number;
}

/**
 * Forward the user-facing "Merge Multilayer Walls" toggle (issue #540)
 * down to this worker's IfcAPI. Hosts should send this AFTER `init`
 * and BEFORE the first `process` / `stream-start` so the flag is
 * already in effect when geometry processing begins. Default in
 * Rust is `false` — sending `enabled: false` (or never sending the
 * message) keeps existing behaviour.
 */
export interface GeometryWorkerSetMergeLayersMessage {
  type: 'set-merge-layers';
  enabled: boolean;
}

/**
 * Forward the model-diff "compute geometry hashes" toggle (issue #924) down
 * to this worker's IfcAPI. Send AFTER `init` and BEFORE the first
 * `stream-start`, mirroring `set-merge-layers`. A positive `tolerance`
 * (metres) enables fingerprinting; `null` disables. Default Rust state is
 * off, so never sending the message keeps zero overhead.
 */
export interface GeometryWorkerSetComputeGeometryHashesMessage {
  type: 'set-compute-geometry-hashes';
  tolerance: number | null;
}

/**
 * Forward the consumer-selected tessellation detail level (issue #976) down
 * to this worker's IfcAPI. Send AFTER `init` and BEFORE the first
 * `stream-start`, mirroring `set-merge-layers`. `null` keeps the engine
 * default (`'medium'` — output identical to the pre-quality pipeline), so
 * never sending the message changes nothing.
 */
export interface GeometryWorkerSetTessellationQualityMessage {
  type: 'set-tessellation-quality';
  level: TessellationQuality | null;
}

export type GeometryWorkerRequest =
  | GeometryWorkerInitMessage
  | GeometryWorkerStreamStartMessage
  | GeometryWorkerStreamChunkMessage
  | GeometryWorkerStreamEndMessage
  | GeometryWorkerSetStylesMessage
  | GeometryWorkerSetEntityIndexMessage
  | GeometryWorkerSetMergeLayersMessage
  | GeometryWorkerSetComputeGeometryHashesMessage
  | GeometryWorkerSetTessellationQualityMessage
  | GeometryWorkerPrePassMessage;

export interface GeometryWorkerBatchMessage {
  type: 'batch';
  meshes: {
    expressId: number;
    ifcType?: string;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    color: [number, number, number, number];
    shadingColor?: [number, number, number, number];
    // #961: optional surface texture + per-vertex UVs (transferables).
    uvs?: MeshData['uvs'];
    texture?: MeshData['texture'];
    /** RTC-invariant per-entity geometry fingerprint, present only when
     *  geometry hashing was enabled via `set-compute-geometry-hashes`.
     *  A `bigint` survives the structured-clone `postMessage`. */
    geometryHash?: bigint;
  }[];
}

export interface GeometryWorkerProgressMessage {
  type: 'progress';
  /** Jobs handed to WASM so far within the current slice (pre-call count). */
  processedJobs: number;
  totalJobs: number;
}

export interface GeometryWorkerCompleteMessage {
  type: 'complete';
  totalMeshes: number;
}

export interface GeometryWorkerErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Optional memory snapshot emitted right after `complete`. Lets the main
 * thread aggregate per-worker WASM heap usage (which it cannot read
 * directly across the worker realm boundary) and total mesh bytes
 * pushed back via the transfer list.
 */
export interface GeometryWorkerMemoryMessage {
  type: 'memory';
  /** Total bytes of all positions+normals+indices typed arrays this worker emitted. */
  meshBytes: number;
  /** WebAssembly.Memory.buffer.byteLength inside this worker's WASM instance. */
  wasmHeapBytes: number;
}

let api: IfcAPI | null = null;

/**
 * Captured at the explicit `init` message and used for every subsequent
 * lazy `await init(...)` call in this worker. When undefined, wasm-bindgen
 * falls back to its built-in `new URL('ifc-lite_bg.wasm', import.meta.url)`
 * resolution — which works in Vite + webpack 5 today but breaks for
 * consumers shipping the worker from a separate origin / Blob URL.
 * See `GeometryWorkerInitMessage.wasmUrl` for the rationale.
 */
let cachedWasmUrl: string | undefined = undefined;

/**
 * Idempotent wasm + IfcAPI initializer. Centralises the
 * `if (!api) { await init(); api = new IfcAPI(); ... }` boilerplate that
 * every message handler used to repeat. Honours `cachedWasmUrl` so the
 * explicit-URL plumbing only has to set state in one place. Returns the
 * `IfcAPI` so call sites can use the value directly without a non-null
 * assertion on the module-level `api`.
 */
async function ensureInit(): Promise<IfcAPI> {
  if (api) return api;
  await init(cachedWasmUrl);
  api = new IfcAPI();
  mergeLayersApplied = false;
  applyMergeLayersToApi();
  geometryHashApplied = false;
  applyComputeGeometryHashesToApi();
  tessellationQualityApplied = false;
  applyTessellationQualityToApi();
  return api;
}

/**
 * Cached merge-layers flag for this worker. The host may post
 * `set-merge-layers` BEFORE `init` (the controller pattern) so we
 * remember the latest value and re-apply once the IfcAPI is built.
 * The Rust agent's contract is: state lives on the IfcAPI instance,
 * so we only need to push it once per API construction.
 */
let mergeLayersFlag: boolean = false;
let mergeLayersApplied: boolean = false;

/** Narrow typed wrapper for the optional `setMergeLayers` extension. */
type IfcAPIWithMerge = IfcAPI & {
  setMergeLayers?: (enabled: boolean) => void;
  setComputeGeometryHashes?: (tolerance?: number | null) => void;
  setTessellationQuality?: (level?: string | null) => void;
};

/**
 * Push the cached `mergeLayersFlag` onto the IfcAPI. Idempotent — only
 * fires once per API instance unless `markMergeLayersDirty` is called
 * (used when the host updates the flag mid-session).
 */
function applyMergeLayersToApi(): void {
  if (!api || mergeLayersApplied) return;
  const merging = api as IfcAPIWithMerge;
  if (typeof merging.setMergeLayers === 'function') {
    merging.setMergeLayers(mergeLayersFlag);
  }
  mergeLayersApplied = true;
}

/**
 * Cached geometry-hash tolerance for this worker (issue #924), mirroring
 * the merge-layers replay contract: the host may post the toggle before
 * `init`, so we remember it and re-apply once the IfcAPI exists.
 */
let geometryHashTolerance: number | null = null;
let geometryHashApplied: boolean = false;

/** Push the cached geometry-hash tolerance onto the IfcAPI (once per API). */
function applyComputeGeometryHashesToApi(): void {
  if (!api || geometryHashApplied) return;
  const hashing = api as IfcAPIWithMerge;
  if (typeof hashing.setComputeGeometryHashes === 'function') {
    hashing.setComputeGeometryHashes(geometryHashTolerance);
  }
  geometryHashApplied = true;
}

/**
 * Cached tessellation-quality level for this worker (issue #976), mirroring
 * the merge-layers replay contract: the host may post the toggle before
 * `init`, so we remember it and re-apply once the IfcAPI exists. `null`
 * keeps the Rust default (Medium — historical densities).
 */
let tessellationQuality: TessellationQuality | null = null;
let tessellationQualityApplied: boolean = false;

/** Push the cached tessellation quality onto the IfcAPI (once per API). */
function applyTessellationQualityToApi(): void {
  if (!api || tessellationQualityApplied) return;
  const quality = api as IfcAPIWithMerge;
  if (typeof quality.setTessellationQuality === 'function') {
    quality.setTessellationQuality(tessellationQuality);
  }
  tessellationQualityApplied = true;
}

/**
 * Build a Uint8Array view over the shared buffer. Modern wasm-bindgen accepts
 * SAB-backed views directly and copies them into linear memory itself, so an
 * extra JS-side `.set()` copy is wasted memory (was N × file_size in the old
 * code path). If the WASM call rejects the SAB view on a given runtime, the
 * caller catches the error and retries with `materialiseSharedBytes`.
 */
function viewSharedBytes(sharedBuffer: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(sharedBuffer);
}

/** Fallback path: copy SAB into a fresh ArrayBuffer-backed Uint8Array. */
function materialiseSharedBytes(sharedBuffer: SharedArrayBuffer): Uint8Array {
  const local = new Uint8Array(sharedBuffer.byteLength);
  local.set(new Uint8Array(sharedBuffer));
  return local;
}

/**
 * Per-load processing session shared by the legacy `process` path and the
 * streaming `stream-*` path. Holds the metadata (RTC, voids, styles) and
 * the per-mesh accumulators between successive `stream-chunk` calls.
 */
interface ProcessingSession {
  sharedBuffer: SharedArrayBuffer;
  localBytes: Uint8Array;
  sabFallbackTaken: boolean;
  unitScale: number;
  rtcX: number; rtcY: number; rtcZ: number;
  needsShift: boolean;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  planeAngleToRadians: number | undefined;
  materialElementIds: Uint32Array | undefined;
  materialColorCounts: Uint32Array | undefined;
  materialColors: Uint8Array | undefined;
  pendingMeshes: GeometryWorkerBatchMessage['meshes'];
  pendingTransfers: ArrayBuffer[];
  totalMeshesEmitted: number;
  cumulativeMeshBytes: number;
}

let activeSession: ProcessingSession | null = null;

/**
 * Jobs per inner WASM call inside `processSliceStreaming`.
 *
 * Two forces pull in opposite directions:
 *
 * - Cache locality: every `processGeometryBatch` call allocates a fresh
 *   `EntityDecoder.cache` (FxHashMap) in Rust, so smaller batches re-decode
 *   shared sub-entities (`IfcCartesianPoint`, placements, …) per call.
 *   This once justified an effectively-unbounded value (1M): one WASM call
 *   per worker slice. The dominant per-call fixed cost back then was an
 *   O(file) IFCPROJECT scan for unit scales — that is now resolved once per
 *   worker and seeded into each batch decoder, so the remaining per-call
 *   overhead is small.
 *
 * - Liveness: a `processGeometryBatch` call is synchronous WASM — no batch
 *   events, no progressive rendering, and nothing feeds the stream watchdog
 *   while it runs. With one call per slice, a CSG-heavy model wedges every
 *   worker for its entire slice (minutes on 70 MB+ steel models): the host
 *   sees zero events, the watchdog kills a *healthy* load, and the user
 *   stares at an empty viewport until the first worker finishes everything.
 *
 * 512 keeps typical call duration well under a second (~1.6 ms/job measured
 * on a 72 MB IFC4 model) so meshes stream in continuously and the watchdog
 * only fires on real wedges, while keeping the re-decode overhead a few
 * percent (shared-entity locality is mostly intra-batch at this size).
 */
const STREAM_BATCH_SIZE = 512;

function startSession(input: {
  sharedBuffer: SharedArrayBuffer;
  unitScale: number;
  rtcX: number; rtcY: number; rtcZ: number;
  needsShift: boolean;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  planeAngleToRadians?: number;
  materialElementIds?: Uint32Array;
  materialColorCounts?: Uint32Array;
  materialColors?: Uint8Array;
}): ProcessingSession {
  return {
    sharedBuffer: input.sharedBuffer,
    localBytes: viewSharedBytes(input.sharedBuffer),
    sabFallbackTaken: false,
    unitScale: input.unitScale,
    rtcX: input.rtcX, rtcY: input.rtcY, rtcZ: input.rtcZ,
    needsShift: input.needsShift,
    voidKeys: input.voidKeys,
    voidCounts: input.voidCounts,
    voidValues: input.voidValues,
    styleIds: input.styleIds,
    styleColors: input.styleColors,
    planeAngleToRadians: input.planeAngleToRadians,
    materialElementIds: input.materialElementIds,
    materialColorCounts: input.materialColorCounts,
    materialColors: input.materialColors,
    pendingMeshes: [],
    pendingTransfers: [],
    totalMeshesEmitted: 0,
    cumulativeMeshBytes: 0,
  };
}

function flushPending(session: ProcessingSession): void {
  if (session.pendingMeshes.length === 0) return;
  const meshes = session.pendingMeshes;
  const transfers = session.pendingTransfers;
  session.pendingMeshes = [];
  session.pendingTransfers = [];
  session.totalMeshesEmitted += meshes.length;
  (self as unknown as Worker).postMessage(
    { type: 'batch', meshes } as GeometryWorkerBatchMessage,
    transfers,
  );
}

function collectMeshes(
  session: ProcessingSession,
  collection: ReturnType<IfcAPI['processGeometryBatch']>,
): void {
  try {
    // Per-entity geometry fingerprints (issue #924) — empty unless hashing was
    // enabled via `set-compute-geometry-hashes`. Read inside the try so
    // `collection.free()` in finally still runs if extraction throws.
    const geometryHashes = extractGeometryHashesFromCollection(collection);

    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      if (!mesh) continue;
      try {
        const positions = new Float32Array(mesh.positions);
        const normals = new Float32Array(mesh.normals);
        const indices = new Uint32Array(mesh.indices);
        // Read the WASM copy-to-JS color getter once; indexing it directly
        // would copy a fresh Float32Array out of WASM per access.
        const color = mesh.color;
        // Optional SurfaceColour for the GLB exporter's "Shading" mode —
        // parity with the single-thread converter in geometry-coordinate.ts
        // (the worker path silently dropped it, degrading "Shading" export
        // on the DEFAULT load path — alignment audit).
        const shadingArray = mesh.shadingColor;
        const shadingColor: [number, number, number, number] | undefined =
          shadingArray && shadingArray.length === 4
            ? [shadingArray[0], shadingArray[1], shadingArray[2], shadingArray[3]]
            : undefined;
        const geometryHash = geometryHashes.get(mesh.expressId);
        const meshData: MeshData = {
          expressId: mesh.expressId,
          ifcType: mesh.ifcType,
          positions, normals, indices,
          color: [color[0], color[1], color[2], color[3]],
          ...(shadingColor ? { shadingColor } : {}),
          // Provenance for the Model/Types switch (0=occurrence, 1=orphan type,
          // 2=instanced type). Older wasm bundles lack the getter → default 0.
          geometryClass: mesh.geometryClass ?? 0,
        };
        session.pendingTransfers.push(positions.buffer, normals.buffer, indices.buffer);
        session.cumulativeMeshBytes += positions.byteLength + normals.byteLength + indices.byteLength;
        // #961: surface texture + per-vertex UVs (decoded to RGBA8 in Rust). Carried
        // as transferables so there is no SAB→scratch copy (see SAB-streaming memo).
        if (mesh.hasTexture) {
          const uvs = new Float32Array(mesh.uvs);
          const rgba = new Uint8Array(mesh.textureRgba);
          meshData.uvs = uvs;
          meshData.texture = {
            rgba,
            width: mesh.textureWidth,
            height: mesh.textureHeight,
            repeatS: mesh.textureRepeatS,
            repeatT: mesh.textureRepeatT,
          };
          session.pendingTransfers.push(uvs.buffer, rgba.buffer);
          session.cumulativeMeshBytes += uvs.byteLength + rgba.byteLength;
        }
        // #924: attach the per-entity geometry fingerprint (empty Map → no-op
        // unless geometry hashing was enabled).
        if (geometryHash !== undefined) meshData.geometryHash = geometryHash;
        session.pendingMeshes.push(meshData);
      } finally {
        mesh.free();
      }
    }
  } finally {
    collection.free();
  }
}

/**
 * Read the per-entity geometry hashes off a MeshCollection's parallel
 * `geometryHashIds`/`geometryHashValues` arrays into a `Map`. Empty when
 * hashing is off or the WASM build predates the getters. Must run before
 * `collection.free()`.
 */
function extractGeometryHashesFromCollection(
  collection: ReturnType<IfcAPI['processGeometryBatch']>,
): Map<number, bigint> {
  const map = new Map<number, bigint>();
  const c = collection as unknown as {
    geometryHashCount?: number;
    geometryHashIds?: Uint32Array;
    geometryHashValues?: BigUint64Array;
  };
  const count = c.geometryHashCount ?? 0;
  if (count === 0) return map;
  const ids = c.geometryHashIds;
  const values = c.geometryHashValues;
  if (!ids || !values) return map;
  const n = Math.min(ids.length, values.length);
  for (let i = 0; i < n; i++) map.set(ids[i], values[i]);
  return map;
}

/**
 * Process a slice of jobsFlat with binary-split recovery. Mirrors the
 * pre-streaming behaviour: if WASM throws on the whole slice, split in
 * half and retry. Single-entity failures are skipped after one re-init
 * attempt because a stack overflow can corrupt the WASM heap.
 */
async function processBatch(session: ProcessingSession, jobs: Uint32Array): Promise<void> {
  const numJobs = Math.floor(jobs.length / 3);
  if (numJobs === 0) return;

  try {
    const ifcApi = await ensureInit();
    const collection = ifcApi.processGeometryBatch(
      session.localBytes, jobs, session.unitScale,
      session.rtcX, session.rtcY, session.rtcZ, session.needsShift,
      session.voidKeys, session.voidCounts, session.voidValues,
      session.styleIds, session.styleColors,
      session.planeAngleToRadians,
      session.materialElementIds, session.materialColorCounts, session.materialColors,
    );
    collectMeshes(session, collection);
  } catch (err) {
    const msg = (err as Error).message;
    if (!session.sabFallbackTaken && session.localBytes.buffer instanceof SharedArrayBuffer) {
      session.sabFallbackTaken = true;
      console.warn(`[Worker] processGeometryBatch rejected SAB view (${msg}), falling back to copy`);
      session.localBytes = materialiseSharedBytes(session.sharedBuffer);
      await processBatch(session, jobs);
      return;
    }
    if (numJobs === 1) {
      console.warn(`[Worker] Skipping entity #${jobs[0]}: ${msg}`);
      api = null;
      return;
    }
    console.warn(`[Worker] Batch of ${numJobs} entities failed (${msg}), splitting…`);
    api = null;
    const mid = Math.floor(numJobs / 2) * 3;
    await processBatch(session, jobs.slice(0, mid));
    await processBatch(session, jobs.slice(mid));
  }
}

/** Run a slice in STREAM_BATCH_SIZE chunks, flushing after each chunk. */
async function processSliceStreaming(session: ProcessingSession, jobsFlat: Uint32Array): Promise<void> {
  const totalJobs = Math.floor(jobsFlat.length / 3);
  for (let jobOffset = 0; jobOffset < totalJobs; jobOffset += STREAM_BATCH_SIZE) {
    // Liveness heartbeat BEFORE entering the synchronous WASM call: the host
    // forwards it as a `progress` stream event so the consumer's stall
    // watchdog measures "time inside one bounded WASM call", not "time since
    // the last mesh" — a CSG-heavy region can legitimately produce nothing
    // for tens of seconds while every worker is busy. Also covers batches
    // that produce zero meshes (flushPending no-ops on empty).
    (self as unknown as Worker).postMessage(
      { type: 'progress', processedJobs: jobOffset, totalJobs } as GeometryWorkerProgressMessage,
    );
    const start = jobOffset * 3;
    const end = Math.min(start + STREAM_BATCH_SIZE * 3, jobsFlat.length);
    await processBatch(session, jobsFlat.subarray(start, end));
    flushPending(session);
  }
}

function emitSessionEnd(session: ProcessingSession): void {
  flushPending(session); // safety net for tail meshes
  let wasmHeapBytes = 0;
  try {
    const wasmMemory = api?.getMemory() as { buffer?: ArrayBuffer } | undefined;
    wasmHeapBytes = wasmMemory?.buffer?.byteLength ?? 0;
  } catch {
    /* memory accounting only — safe to ignore */
  }
  (self as unknown as Worker).postMessage(
    { type: 'memory', meshBytes: session.cumulativeMeshBytes, wasmHeapBytes } as GeometryWorkerMemoryMessage,
  );
  (self as unknown as Worker).postMessage(
    { type: 'complete', totalMeshes: session.totalMeshesEmitted } as GeometryWorkerCompleteMessage,
  );
}

/**
 * Serialise message handlers via a tail promise. Web Worker `onmessage` is
 * async and the runtime dispatches the next message as soon as the
 * handler hits its first `await`. Without this serialisation a
 * `stream-start` that awaits `init()` can be overtaken by a
 * `stream-chunk` arriving on the next tick — and the chunk handler runs
 * before `activeSession` is set, throwing `stream-chunk received before
 * stream-start`. The tail-promise pattern queues every handler behind
 * its predecessor, restoring the FIFO contract callers expect.
 */
let messageTail: Promise<void> = Promise.resolve();

self.onmessage = (rawEvent: MessageEvent<GeometryWorkerRequest>) => {
  messageTail = messageTail.then(() => handleMessage(rawEvent)).catch((err) => {
    (self as unknown as Worker).postMessage(
      { type: 'error', message: err instanceof Error ? err.message : String(err) } as GeometryWorkerErrorMessage,
    );
  });
};

async function handleMessage(e: MessageEvent<GeometryWorkerRequest>): Promise<void> {
  try {
    if (e.data.type === 'prepass-streaming') {
      const ifcApi = await ensureInit();
      // Heartbeat: lets the host watchdog know the worker is alive even
      // before the first chunk lands.
      (self as unknown as Worker).postMessage({ type: 'prepass-progress', phase: 'parsing' });
      const sharedBuffer = e.data.sharedBuffer;
      const chunkSize = e.data.chunkSize ?? 50_000;

      // Forward Rust events 1:1 — the host (`geometry-parallel.ts`) treats
      // them as the streaming-prepass protocol. SAB-decode fallback: try the
      // zero-copy view first, fall back to a materialised copy only if
      // wasm-bindgen rejects the view.
      let view = viewSharedBytes(sharedBuffer);
      let triedFallback = false;
      const onEvent = (event: unknown) => {
        (self as unknown as Worker).postMessage({ type: 'prepass-stream', event });
      };
      try {
        ifcApi.buildPrePassStreaming(view, onEvent, chunkSize);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!triedFallback) {
          triedFallback = true;
          console.warn(`[Worker] Streaming prepass with SAB view failed (${msg}), retrying with copy`);
          view = materialiseSharedBytes(sharedBuffer);
          ifcApi.buildPrePassStreaming(view, onEvent, chunkSize);
        } else {
          throw err;
        }
      }
      return;
    }

    if (e.data.type === 'init') {
      if (e.data.wasmUrl) cachedWasmUrl = e.data.wasmUrl;
      if (e.data.wasmModule) {
        initSync({ module_or_path: e.data.wasmModule });
        api = new IfcAPI();
        mergeLayersApplied = false;
        applyMergeLayersToApi();
        geometryHashApplied = false;
        applyComputeGeometryHashesToApi();
        tessellationQualityApplied = false;
        applyTessellationQualityToApi();
      } else {
        await ensureInit();
      }
      (self as unknown as Worker).postMessage({ type: 'ready' });
      return;
    }

    if (e.data.type === 'stream-start') {
      await ensureInit();
      activeSession = startSession({
        sharedBuffer: e.data.sharedBuffer,
        unitScale: e.data.unitScale,
        rtcX: e.data.rtcX, rtcY: e.data.rtcY, rtcZ: e.data.rtcZ,
        needsShift: e.data.needsShift,
        voidKeys: e.data.voidKeys,
        voidCounts: e.data.voidCounts,
        voidValues: e.data.voidValues,
        styleIds: e.data.styleIds,
        styleColors: e.data.styleColors,
        planeAngleToRadians: e.data.planeAngleToRadians,
        materialElementIds: e.data.materialElementIds,
        materialColorCounts: e.data.materialColorCounts,
        materialColors: e.data.materialColors,
      });
      return;
    }

    if (e.data.type === 'stream-chunk') {
      if (!activeSession) {
        throw new Error('stream-chunk received before stream-start');
      }
      await processSliceStreaming(activeSession, e.data.jobsFlat);
      return;
    }

    if (e.data.type === 'set-styles') {
      // Update the active session in place. The streaming pre-pass posts
      // this AFTER its main scan completes, so workers may have already
      // processed several chunks with empty styles (default per-type
      // colors). The host emits a `colorUpdate` event on the receive side
      // to retroactively fix already-emitted meshes.
      if (!activeSession) return;
      activeSession.styleIds = e.data.styleIds;
      activeSession.styleColors = e.data.styleColors;
      activeSession.voidKeys = e.data.voidKeys;
      activeSession.voidCounts = e.data.voidCounts;
      activeSession.voidValues = e.data.voidValues;
      activeSession.materialElementIds = e.data.materialElementIds;
      activeSession.materialColorCounts = e.data.materialColorCounts;
      activeSession.materialColors = e.data.materialColors;
      return;
    }

    if (e.data.type === 'set-entity-index') {
      // Hand the pre-built entity index from the pre-pass worker into
      // this worker's IfcAPI. Without this, processGeometryBatch's lazy
      // build path fires on the first call and re-scans the entire file
      // (~5 s on a 1 GB IFC) — the dominant TTFG bottleneck before this
      // change. Now the only cost is FxHashMap construction from the
      // input slices (~1 s for 14 M entries).
      const ifcApi = await ensureInit();
      ifcApi.setEntityIndex(e.data.ids, e.data.starts, e.data.lengths);
      return;
    }

    if (e.data.type === 'set-merge-layers') {
      // Cache the requested flag — if the API already exists, push it
      // through immediately; otherwise the next `new IfcAPI()` path
      // will pick it up via `applyMergeLayersToApi`. Default is false
      // so omitting this message keeps existing behaviour intact.
      mergeLayersFlag = e.data.enabled === true;
      mergeLayersApplied = false;
      applyMergeLayersToApi();
      return;
    }

    if (e.data.type === 'set-compute-geometry-hashes') {
      // Same cache-and-replay contract as set-merge-layers (issue #924).
      const tol = e.data.tolerance;
      geometryHashTolerance = tol != null && tol > 0 ? tol : null;
      geometryHashApplied = false;
      applyComputeGeometryHashesToApi();
      return;
    }

    if (e.data.type === 'set-tessellation-quality') {
      // Same cache-and-replay contract as set-merge-layers (issue #976).
      tessellationQuality = e.data.level ?? null;
      tessellationQualityApplied = false;
      applyTessellationQualityToApi();
      return;
    }

    if (e.data.type === 'stream-end') {
      if (!activeSession) {
        throw new Error('stream-end received before stream-start');
      }
      emitSessionEnd(activeSession);
      activeSession = null;
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage(
      { type: 'error', message: err instanceof Error ? err.message : String(err) } as GeometryWorkerErrorMessage,
    );
  }
}
