/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { initSync, IfcAPI } from '@ifc-lite/wasm';
import { initWasmWithRetry } from './wasm-init-retry.js';
import { largeFilePrepassError } from './huge-file-error.js';
import type { MeshData, TessellationQuality } from './types.js';
import { mergeGeometryDiagnostics, type GeometryDiagnostics } from './diagnostics.js';
import {
  DEFAULT_BATCH_SIZING,
  resolveBatchSizing,
  nextAdaptiveBatchJobs,
  type BatchSizingConfig,
} from './batch-sizing.js';

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
  /** #1097 optional adaptive-batch-sizing override (hardware tuning hook).
   *  Omitted ⇒ DEFAULT_BATCH_SIZING. Resolved/validated in the worker. */
  batchSizing?: Partial<BatchSizingConfig>;
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

/**
 * Install the three per-content structures the streaming pre-pass computed
 * ONCE, so this worker's first `processGeometryBatch` skips rebuilding them
 * with its own full-file walk (issue #957 orphan/instanced type geometry +
 * #563 material-layer slicing). Without this, every worker independently
 * re-walks the whole 200-340 MB file on its first type-product / layered
 * batch — N concurrent walks contending for memory bandwidth.
 *
 * `referencedRepmaps` and `instantiatedTypeIds` are id sets; the `mli*` arrays
 * are the flat SoA encoding of the `MaterialLayerIndex` (see Rust
 * `MaterialLayerFlat`). Applied AFTER `set-entity-index` (which clears these
 * caches on content swap), so the injected values survive. Absent ⇒ the
 * worker's lazy per-batch build (the byte-identical fallback) runs instead.
 */
export interface GeometryWorkerSetPrepassColumnsMessage {
  type: 'set-prepass-columns';
  referencedRepmaps: Uint32Array;
  instantiatedTypeIds: Uint32Array;
  /** #1623 Phase 3 don't-bake plan: RepresentationMap ids an IfcMappedItem
   *  instantiates >= 2x. Installed via `setMappedInstancePlan`; absent/empty ⇒
   *  the batch never arms the don't-bake path (materializes every occurrence). */
  mappedInstancePlan?: Uint32Array;
  mliElementIds: Uint32Array;
  mliAxis: Uint32Array;
  mliLayerCounts: Uint32Array;
  mliDirectionSense: Float64Array;
  mliOffset: Float64Array;
  mliLayerMaterialIds: Uint32Array;
  mliLayerThicknesses: Float64Array;
}

/**
 * Sharded pre-pass: scan the entity index over one byte range of the
 * shared file buffer. Dispatched to each idle geometry worker up front (before
 * `stream-start`) so the N workers build the index in parallel; the main thread
 * stitches the returned `shard-result` columns. `shardIndex` echoes back so the
 * host can slot the result. Byte offsets returned are GLOBAL.
 */
export interface GeometryWorkerScanShardMessage {
  type: 'scan-shard';
  sharedBuffer: SharedArrayBuffer;
  shardIndex: number;
  rangeStart: number;
  rangeEnd: number;
}

export interface GeometryWorkerPrePassMessage {
  type: 'prepass-streaming';
  sharedBuffer: SharedArrayBuffer;
  /** Jobs per chunk (defaults to 50_000). */
  chunkSize?: number;
  /** #1097 load-time visibility filter: uppercase STEP keywords whose
   *  geometry jobs are skipped at generation (e.g. ["IFCSPACE","IFCANNOTATION"]).
   *  Toggling one back on requires a reload. Omitted ⇒ load everything. */
  disabledTypes?: string[];
  /** Skip #957 type-library (IfcTypeProduct) geometry at load (default Model
   *  view doesn't render it). Omitted ⇒ load it. */
  skipTypeGeometry?: boolean;
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
 * Toggle the GPU-instancing partition for this worker (default on). Send AFTER `init`
 * and BEFORE the first `stream-start`, mirroring `set-merge-layers`. The host disables
 * it for federated loads so a federated model's geometry stays on the flat path
 * (instancing is primary-model only).
 */
export interface GeometryWorkerSetInstancingMessage {
  type: 'set-instancing-enabled';
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

/**
 * Forward the tier-independent small-cut skip (issue #1286) to this worker's
 * IfcAPI. Sent AFTER `init` and BEFORE the first `stream-start`, mirroring
 * `set-tessellation-quality`. `false` (the default) keeps every cut, so never
 * sending the message changes nothing.
 */
export interface GeometryWorkerSetSkipSmallCutsMessage {
  type: 'set-skip-small-cuts';
  enabled: boolean;
}

export type GeometryWorkerRequest =
  | GeometryWorkerInitMessage
  | GeometryWorkerStreamStartMessage
  | GeometryWorkerStreamChunkMessage
  | GeometryWorkerStreamEndMessage
  | GeometryWorkerSetStylesMessage
  | GeometryWorkerSetEntityIndexMessage
  | GeometryWorkerSetPrepassColumnsMessage
  | GeometryWorkerSetMergeLayersMessage
  | GeometryWorkerSetInstancingMessage
  | GeometryWorkerSetComputeGeometryHashesMessage
  | GeometryWorkerSetTessellationQualityMessage
  | GeometryWorkerSetSkipSmallCutsMessage
  | GeometryWorkerScanShardMessage
  | GeometryWorkerResolveStylesShardMessage
  | GeometryWorkerPrePassShardedMessage
  | GeometryWorkerFinalizeStylesMessage
  | GeometryWorkerPrePassMessage;

/**
 * SPIKE response to `scan-shard`: one shard's entity-index columns + the
 * handoff (global start of the first entity at/after `rangeEnd`, or `-1` at
 * EOF). Columns are transferred back to the main thread for stitching.
 */
export interface GeometryWorkerShardResultMessage {
  type: 'shard-result';
  shardIndex: number;
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
  /** Per-record prepass class (PREPASS_CLASS_*; 4 = IfcStyledItem). */
  classes: Uint8Array;
  handoff: number;
}

/**
 * Sharded pre-pass: resolve one contiguous (file-ordered) slice of the
 * styled-item span list on this worker (must arrive AFTER set-entity-index —
 * workers apply messages FIFO). `spans` is [id, start, len] triples.
 */
export interface GeometryWorkerResolveStylesShardMessage {
  type: 'resolve-styles-shard';
  sharedBuffer: SharedArrayBuffer;
  sliceIndex: number;
  spans: Uint32Array;
}

/** Response to resolve-styles-shard: raw resolved style maps as flat columns. */
export interface GeometryWorkerStylesShardResultMessage {
  type: 'styles-shard-result';
  sliceIndex: number;
  orphanIds: Uint32Array;
  orphanColors: Float32Array;
  geomIds: Uint32Array;
  geomColors: Float32Array;
  /** Set when resolution threw; the host falls back / logs. */
  error?: string;
}

/**
 * Sharded pre-pass main call: like prepass-streaming but with the PREBUILT
 * (stitched) entity index columns, and styles resolution EXTERNAL (no styles
 * event from this call — the host finalizes via finalize-styles below).
 */
export interface GeometryWorkerPrePassShardedMessage {
  type: 'prepass-streaming-sharded';
  sharedBuffer: SharedArrayBuffer;
  chunkSize?: number;
  disabledTypes?: string[];
  skipTypeGeometry?: boolean;
  indexIds: Uint32Array;
  indexStarts: Uint32Array;
  indexLengths: Uint32Array;
  /** Per-record prepass classes — drives columns discovery (no byte scan). */
  indexClasses: Uint8Array;
}

/**
 * Sharded pre-pass: merge the shard-resolved styled maps with the stashed
 * support spans and emit the canonical `styles` event through the same
 * prepass-stream channel. Queued behind prepass-streaming-sharded (FIFO), so
 * the stash is always present when it runs.
 */
export interface GeometryWorkerFinalizeStylesMessage {
  type: 'finalize-styles';
  sharedBuffer: SharedArrayBuffer;
  orphanIds: Uint32Array;
  orphanColors: Float32Array;
  geomIds: Uint32Array;
  geomColors: Float32Array;
  /** Support spans ([id,start,len] triples) extracted from the shard classes. */
  colourMapSpans: Uint32Array;
  materialDefSpans: Uint32Array;
  relMaterialSpans: Uint32Array;
  voidSpans: Uint32Array;
  fillsSpans: Uint32Array;
  aggregateSpans: Uint32Array;
  planeAngleToRadians: number;
}

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
    // #1781: external image texture reference (`IfcImageTexture`) — the main
    // thread resolves it against the `.ifcZIP` sibling images by `textureId`.
    textureRef?: MeshData['textureRef'];
    /** RTC-invariant per-entity geometry fingerprint, present only when
     *  geometry hashing was enabled via `set-compute-geometry-hashes`.
     *  A `bigint` survives the structured-clone `postMessage`. */
    geometryHash?: bigint;
  }[];
  /** GPU-instancing: per-batch IFNS shards (transferable ArrayBuffers). The
   *  renderer decodes + GPU-instances them. Opaque repeated occurrences render
   *  ONLY via these (they were taken off the flat `meshes` array). */
  instancedShards?: ArrayBuffer[];
  /** Occurrence count carried by `instancedShards` this batch — folded into the
   *  pool's running mesh total so it counts flat + instanced geometry. */
  instancedOccurrences?: number;
  /** Geometry-diff hashes (#924) for instanced-ONLY entities (no flat mesh
   *  carries them). Parallel arrays: express id → hash. Present only when
   *  geometry hashing is enabled AND a batch routed an entity's whole geometry
   *  to the instanced shard. Transferable. */
  instancedGeometryHashIds?: Uint32Array;
  instancedGeometryHashValues?: BigUint64Array;
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
  /** CSG / opening diagnostics merged over this worker's batches (the
   *  GeometryDiagnostics contract). Omitted when none were recorded. */
  diagnostics?: GeometryDiagnostics;
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
 *
 * `init` is wrapped in {@link initWasmWithRetry} so a transient engine-binary
 * download failure (a cold CDN edge, mid-deploy race, or flaky proxy) is
 * retried once before failing. `__wbg_init` only short-circuits on
 * `wasm !== undefined`, so a retry after a failed load safely re-fetches.
 */
async function ensureInit(): Promise<IfcAPI> {
  if (api) return api;
  await initWasmWithRetry(() => init(cachedWasmUrl), { label: 'geometry.worker' });
  api = new IfcAPI();
  mergeLayersApplied = false;
  applyMergeLayersToApi();
  geometryHashApplied = false;
  applyComputeGeometryHashesToApi();
  tessellationQualityApplied = false;
  applyTessellationQualityToApi();
  skipSmallCutsApplied = false;
  applySkipSmallCutsToApi();
  entityIndexApplied = false;
  applyEntityIndexToApi();
  prepassColumnsApplied = false;
  applyPrepassColumnsToApi();
  // Re-install the session source on a recovery re-init (api = null) so the
  // *FromSource batch path isn't silently reading an empty file — same replay
  // contract as the entity index. No-op before a session sets cachedSourceBytes.
  sourceBytesApplied = false;
  applySourceBytesToApi();
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

/**
 * GPU-instancing partition toggle (default on). The host disables it for FEDERATED
 * loads: the instanced render path + entity map are primary-model only (single global
 * scene, primary id space), so a federated model must receive ALL its geometry as flat
 * meshes. With this off, processBatch uses plain processGeometryBatch (no shards), so
 * opaque repeated occurrences stay in the flat stream instead of being dropped.
 */
let instancingEnabled: boolean = true;

/** Narrow typed wrapper for the optional `setMergeLayers` extension. */
type IfcAPIWithMerge = IfcAPI & {
  setMergeLayers?: (enabled: boolean) => void;
  setComputeGeometryHashes?: (tolerance?: number | null) => void;
  setTessellationQuality?: (level?: string | null) => void;
  setSkipSmallCuts?: (on: boolean) => void;
  /** Cold-load lever 1c: store the source file ONCE per load (see
   *  `applySourceBytesToApi`). Absent on wasm builds predating the setter. */
  setSourceBytes?: (data: Uint8Array) => void;
};

/**
 * Narrow wrapper for the pre-pass column setters (issue #957 / #563). Optional
 * so a staged/older engine binary without them degrades to the byte-identical
 * lazy per-worker rebuild instead of throwing.
 */
type IfcAPIWithPrepassColumns = IfcAPI & {
  setReferencedRepmaps?: (ids: Uint32Array) => void;
  setInstantiatedTypeIds?: (ids: Uint32Array) => void;
  /** #1623 Phase 3: install the don't-bake plan (RepresentationMap ids repeated
   *  >= 2x). Optional so an older engine binary degrades to full materialize. */
  setMappedInstancePlan?: (ids: Uint32Array) => void;
  setMaterialLayerIndex?: (
    elementIds: Uint32Array,
    axis: Uint32Array,
    layerCounts: Uint32Array,
    directionSense: Float64Array,
    offset: Float64Array,
    layerMaterialIds: Uint32Array,
    layerThicknesses: Float64Array,
  ) => void;
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
 * Cached tier-independent small-cut skip for this worker (issue #1286), mirroring
 * the merge-layers replay contract: the host posts the toggle before `init`, so
 * remember it and re-apply once the IfcAPI exists. `false` (the default) keeps
 * every cut. Always re-sent per run, so a worker reused by a later export resets
 * to `false` and that export keeps full-fidelity geometry.
 */
let skipSmallCuts: boolean = false;
let skipSmallCutsApplied: boolean = false;

/** Push the cached small-cut skip onto the IfcAPI (once per API). */
function applySkipSmallCutsToApi(): void {
  if (!api || skipSmallCutsApplied) return;
  const cutting = api as IfcAPIWithMerge;
  if (typeof cutting.setSkipSmallCuts === 'function') {
    cutting.setSkipSmallCuts(skipSmallCuts);
  }
  skipSmallCutsApplied = true;
}

/**
 * Cached pre-built entity index (issue #1097). Same replay contract as the
 * flags above, but here it guards a perf cliff rather than a feature toggle:
 * the binary-split recovery in `processBatch` sets `api = null` to force a
 * WASM re-init after a failing entity. Without replay, the freshly-built
 * IfcAPI has no entity index, so its next `processGeometryBatch` falls back to
 * the lazy O(file) re-scan (~5 s on a 1 GB IFC) — a giant silent window that
 * compounds across a cluster of failures. Re-applying the cached index keeps
 * recovery cheap and quiet.
 */
let cachedEntityIndex: { ids: Uint32Array; starts: Uint32Array; lengths: Uint32Array } | null = null;
let entityIndexApplied: boolean = false;

/** Push the cached entity index onto the IfcAPI (once per API). */
function applyEntityIndexToApi(): void {
  const ifcApi = api;
  if (!ifcApi || entityIndexApplied || !cachedEntityIndex) return;
  ifcApi.setEntityIndex(cachedEntityIndex.ids, cachedEntityIndex.starts, cachedEntityIndex.lengths);
  entityIndexApplied = true;
}

/**
 * Cached pre-pass columns (issue #957 / #563). Same replay contract as
 * {@link cachedEntityIndex}: `setEntityIndex` CLEARS these three per-content
 * caches on the IfcAPI (content-swap semantics), so they must be re-installed
 * AFTER every entity-index apply — including the binary-split recovery re-init
 * that rebuilds the IfcAPI. Without replay a recovery would drop the injected
 * columns and the next batch would pay the O(file) rebuild the hoist removed.
 */
let cachedPrepassColumns: GeometryWorkerSetPrepassColumnsMessage | null = null;
let prepassColumnsApplied: boolean = false;

/**
 * Push the cached pre-pass columns onto the IfcAPI (once per API). MUST run
 * AFTER {@link applyEntityIndexToApi} — `setEntityIndex` clears these caches,
 * so applying columns first would have them wiped by a later index apply.
 */
function applyPrepassColumnsToApi(): void {
  const ifcApi = api as IfcAPIWithPrepassColumns | null;
  if (!ifcApi || prepassColumnsApplied || !cachedPrepassColumns) return;
  const c = cachedPrepassColumns;
  if (typeof ifcApi.setReferencedRepmaps === 'function') {
    ifcApi.setReferencedRepmaps(c.referencedRepmaps);
  }
  if (typeof ifcApi.setInstantiatedTypeIds === 'function') {
    ifcApi.setInstantiatedTypeIds(c.instantiatedTypeIds);
  }
  // #1623 Phase 3: install the don't-bake plan so the partitioned batch can arm
  // batch-local instancing. Empty/absent ⇒ the setter no-ops (nothing repeated).
  if (typeof ifcApi.setMappedInstancePlan === 'function' && c.mappedInstancePlan) {
    ifcApi.setMappedInstancePlan(c.mappedInstancePlan);
  }
  if (typeof ifcApi.setMaterialLayerIndex === 'function') {
    ifcApi.setMaterialLayerIndex(
      c.mliElementIds,
      c.mliAxis,
      c.mliLayerCounts,
      c.mliDirectionSense,
      c.mliOffset,
      c.mliLayerMaterialIds,
      c.mliLayerThicknesses,
    );
  }
  prepassColumnsApplied = true;
}

/**
 * Cached session source bytes (cold-load lever 1c). Same replay contract as the
 * entity index above, but it removes a per-call copy rather than a per-load
 * scan: the wasm-bindgen glue `passArray8ToWasm0` mallocs + memcpys the WHOLE
 * source file into the worker's wasm heap on EVERY `processGeometryBatch*` call
 * (~4 ms/call on 169 MB). A huge CSG-dense model adapts down to 64-job batches
 * and makes 600+ calls/worker, so the per-call copy alone is 15-25 s/worker of
 * pure memcpy. `setSourceBytes` copies the file ONCE per load; the `*FromSource`
 * batch variants then read it from the heap. The bytes are identical across a
 * worker's calls (one model per worker), so one copy suffices.
 *
 * Points at the active session's `localBytes`; the SAB fallback in `processBatch`
 * swaps it for the materialised copy and re-applies. `null` between loads
 * (released at `stream-end`). Reset (applied=false) on every fresh IfcAPI so the
 * binary-split recovery re-init (`api = null`) re-installs it, exactly like the
 * entity index. When the loaded wasm predates `setSourceBytes`, the apply is a
 * no-op and `processBatch` stays on the legacy `data`-per-call path.
 */
let cachedSourceBytes: Uint8Array | null = null;
let sourceBytesApplied: boolean = false;

/**
 * Install `cachedSourceBytes` onto the IfcAPI ONCE per instance so the
 * `*FromSource` batch variants read the file from the wasm heap instead of the
 * glue re-copying it every call. MAY THROW if the runtime rejects the
 * (SAB-backed) view during the copy — the `processBatch` caller's SAB fallback
 * materialises and re-applies. No-op on wasm builds without `setSourceBytes`
 * (leaving `sourceBytesApplied` false, so `processBatch` uses the legacy path).
 */
function applySourceBytesToApi(): void {
  const ifcApi = api as IfcAPIWithMerge | null;
  if (!ifcApi || sourceBytesApplied || !cachedSourceBytes) return;
  if (typeof ifcApi.setSourceBytes !== 'function') return;
  ifcApi.setSourceBytes(cachedSourceBytes);
  sourceBytesApplied = true;
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
  /** GPU-instancing: per-batch IFNS shard bytes, flushed with the batch message. */
  pendingInstancedShards: ArrayBuffer[];
  /** Occurrence count accumulated in pendingInstancedShards since the last flush. */
  pendingInstancedOccurrences: number;
  /**
   * Geometry-diff hashes (#924) for elements whose meshes ALL went to the
   * instanced shard, so no flat MeshData carries the hash. Without this the
   * compare feature would silently regress for repeated opaque geometry (it
   * worked when those elements rendered flat). Keyed by express id → hash.
   */
  pendingInstancedGeometryHashes: Map<number, bigint>;
  totalMeshesEmitted: number;
  cumulativeMeshBytes: number;
  /** CSG / opening diagnostics merged across every batch this load (the
   *  GeometryDiagnostics contract). Reported once at completion so a silently
   *  uncut model surfaces a typed summary, not just scattered console warnings. */
  diagnostics: GeometryDiagnostics | null;
}

let activeSession: ProcessingSession | null = null;

/**
 * Adaptive per-call job budget for `processSliceStreaming`. The sizing formula
 * + rationale live in `./batch-sizing.ts` (pure, unit-tested); these are just
 * the running state. `batchSizing` is re-resolved per load from the optional
 * `stream-start` override (a hardware-tuning hook); `adaptiveBatchJobs` is
 * seeded at MAX and relearned each load.
 */
let batchSizing: BatchSizingConfig = DEFAULT_BATCH_SIZING;
let adaptiveBatchJobs = batchSizing.maxJobs;

/** Liveness ping (no slice context) for recovery paths that recurse/re-init. */
function postWorkerHeartbeat(): void {
  (self as unknown as Worker).postMessage(
    { type: 'progress', processedJobs: 0, totalJobs: 0 } as GeometryWorkerProgressMessage,
  );
}

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
    pendingInstancedShards: [],
    pendingInstancedOccurrences: 0,
    pendingInstancedGeometryHashes: new Map(),
    totalMeshesEmitted: 0,
    cumulativeMeshBytes: 0,
    diagnostics: null,
  };
}

function flushPending(session: ProcessingSession): void {
  const instancedShards = session.pendingInstancedShards;
  session.pendingInstancedShards = [];
  const instancedOccurrences = session.pendingInstancedOccurrences;
  session.pendingInstancedOccurrences = 0;
  // Drain the instanced-only geometry-hash side-channel into transferable arrays
  // (#924 compare parity). Cleared every flush so it can't leak across batches.
  const hashEntries = session.pendingInstancedGeometryHashes;
  session.pendingInstancedGeometryHashes = new Map();
  if (
    session.pendingMeshes.length === 0 &&
    instancedShards.length === 0 &&
    hashEntries.size === 0
  ) {
    return;
  }
  const meshes = session.pendingMeshes;
  const transfers = session.pendingTransfers;
  session.pendingMeshes = [];
  session.pendingTransfers = [];
  let instancedGeometryHashIds: Uint32Array | undefined;
  let instancedGeometryHashValues: BigUint64Array | undefined;
  if (hashEntries.size > 0) {
    instancedGeometryHashIds = new Uint32Array(hashEntries.size);
    instancedGeometryHashValues = new BigUint64Array(hashEntries.size);
    let k = 0;
    for (const [id, hash] of hashEntries) {
      instancedGeometryHashIds[k] = id;
      instancedGeometryHashValues[k] = hash;
      k += 1;
    }
    // Freshly allocated above, so `.buffer` is a real ArrayBuffer (TS widens it
    // to ArrayBufferLike); safe to transfer.
    transfers.push(
      instancedGeometryHashIds.buffer as ArrayBuffer,
      instancedGeometryHashValues.buffer as ArrayBuffer,
    );
  }
  // Total counts both routes: flat meshes + instanced occurrences (the latter
  // left the flat array but are still rendered geometry).
  session.totalMeshesEmitted += meshes.length + instancedOccurrences;
  (self as unknown as Worker).postMessage(
    {
      type: 'batch',
      meshes,
      ...(instancedShards.length > 0 ? { instancedShards } : {}),
      ...(instancedOccurrences > 0 ? { instancedOccurrences } : {}),
      ...(instancedGeometryHashIds ? { instancedGeometryHashIds } : {}),
      ...(instancedGeometryHashValues ? { instancedGeometryHashValues } : {}),
    } as GeometryWorkerBatchMessage,
    [...transfers, ...instancedShards],
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
    // Track which entities got a flat mesh; any hashed entity NOT seen here had
    // all its meshes routed to the instanced shard, so its geometry-diff hash
    // would otherwise be dropped (it rides on flat MeshData). Captured below
    // and emitted via a side-channel so compare still sees instanced geometry.
    const flatMeshedIds = new Set<number>();

    for (let i = 0; i < collection.length; i++) {
      // #1097: takeMesh MOVES the mesh out (no clone) — each mesh is read once.
      const mesh = collection.takeMesh(i);
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
        // Per-element local-frame origin (world = origin + position). Older wasm
        // bundles lack the getter; [0,0,0] means absolute. Metadata only — the
        // 3-tuple rides structured-clone, NOT pendingTransfers.
        const originArr = mesh.origin;
        const origin: [number, number, number] | undefined =
          originArr && originArr.length === 3 && (originArr[0] || originArr[1] || originArr[2])
            ? [originArr[0], originArr[1], originArr[2]]
            : undefined;
        // Local (pre-placement) AABB + placement transform (issue #1474);
        // absent on older wasm bundles (no getter) or when not captured.
        const localBoundsArr = mesh.localBounds;
        const localBounds =
          localBoundsArr && localBoundsArr.length === 6
            ? {
                min: [localBoundsArr[0], localBoundsArr[1], localBoundsArr[2]] as [number, number, number],
                max: [localBoundsArr[3], localBoundsArr[4], localBoundsArr[5]] as [number, number, number],
              }
            : undefined;
        const localToWorldArr = mesh.localToWorld;
        const localToWorld =
          localToWorldArr && localToWorldArr.length === 16 ? Array.from(localToWorldArr) : undefined;
        const meshData: MeshData = {
          expressId: mesh.expressId,
          ifcType: mesh.ifcType,
          positions, normals, indices,
          color: [color[0], color[1], color[2], color[3]],
          ...(shadingColor ? { shadingColor } : {}),
          ...(origin ? { origin } : {}),
          ...(localBounds ? { localBounds } : {}),
          ...(localToWorld ? { localToWorld } : {}),
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
        } else if (mesh.textureUrl) {
          // #1781: external image reference (`IfcImageTexture`) — UVs travel as
          // a transferable like #961, but the texture itself is only a URL +
          // repeat flags; the main thread resolves it against the `.ifcZIP`
          // sibling images and decodes ONCE per `textureId`.
          const uvs = new Float32Array(mesh.uvs);
          meshData.uvs = uvs;
          meshData.textureRef = {
            textureId: mesh.textureId,
            url: mesh.textureUrl,
            repeatS: mesh.textureRepeatS,
            repeatT: mesh.textureRepeatT,
          };
          session.pendingTransfers.push(uvs.buffer);
          session.cumulativeMeshBytes += uvs.byteLength;
        }
        // #924: attach the per-entity geometry fingerprint (empty Map → no-op
        // unless geometry hashing was enabled).
        if (geometryHash !== undefined) meshData.geometryHash = geometryHash;
        flatMeshedIds.add(mesh.expressId);
        session.pendingMeshes.push(meshData);
      } finally {
        mesh.free();
      }
    }
    // Instanced-only entities: hashes present in the collection but with no flat
    // mesh emitted this batch. Carry them so the compare fingerprint builder can
    // still detect geometry changes on repeated opaque elements. (#1238 / #924)
    for (const [id, hash] of geometryHashes) {
      if (!flatMeshedIds.has(id)) session.pendingInstancedGeometryHashes.set(id, hash);
    }
    // CSG / opening diagnostics: merge into the per-load accumulator only AFTER
    // mesh extraction succeeds (both batch paths attach a GeometryDiagnostics to
    // the collection). A batch that throws is binary-split + re-run by
    // processBatch; doing the merge here means the failed attempt contributes
    // nothing and the re-run is the sole contributor, so totalCsgFailures and the
    // classification counts stay exact. The diagnostics field is not consumed by
    // takeMesh, so it is still readable after the extraction loop.
    session.diagnostics = mergeGeometryDiagnostics(
      session.diagnostics,
      collection.diagnostics as GeometryDiagnostics | undefined,
    );
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

/** Shape of a PartitionedBatch result (legacy or `*FromSource`). */
type PartitionedBatchResult = {
  takeMeshes(): ReturnType<IfcAPI['processGeometryBatch']> | undefined;
  takeShard(): Uint8Array;
  readonly instancedOccurrences: number;
  free?(): void;
};

/**
 * Narrow wrapper for the optional `*FromSource` batch variants (cold-load lever
 * 1c). Present only on wasm builds that expose `setSourceBytes`; absent ⇒
 * `processBatch` falls back to the legacy `data`-taking variants.
 */
type IfcAPIWithSourceBatch = IfcAPI & {
  processGeometryBatchFromSource?: (...args: unknown[]) => ReturnType<IfcAPI['processGeometryBatch']>;
  processGeometryBatchPartitionedFromSource?: (...args: unknown[]) => PartitionedBatchResult;
};

/**
 * Drain a PartitionedBatch result (legacy OR `*FromSource`): move the flat
 * MeshCollection into the session, push the IFNS instancing shard, fold the
 * instanced-occurrence count, and free the now-empty wrapper. Shared by both
 * call sites so the lever-1c FromSource path is byte-for-byte the legacy path
 * minus the per-call file copy.
 */
function consumePartitioned(session: ProcessingSession, partitioned: PartitionedBatchResult): void {
  try {
    // takeMeshes() MOVES the flat MeshCollection out (take-once); collectMeshes
    // frees it. None only on a second take — we call it once.
    const collection = partitioned.takeMeshes();
    if (collection) collectMeshes(session, collection);
    const shard = partitioned.takeShard();
    if (shard && shard.byteLength > 0) {
      // wasm-bindgen Vec<u8> returns a fresh standalone Uint8Array (offset 0,
      // exact length), so .buffer is safe to transfer. Guard defensively: if
      // it is ever a view into a larger buffer, copy out the exact bytes
      // instead of transferring (and detaching) the parent buffer.
      const exact =
        shard.byteOffset === 0 && shard.byteLength === shard.buffer.byteLength
          ? (shard.buffer as ArrayBuffer)
          : (shard.slice().buffer as ArrayBuffer);
      session.pendingInstancedShards.push(exact);
    }
    // Fold the instanced occurrence count into the streamed mesh total so the
    // viewer's "N meshes" reflects ALL rendered geometry (flat + instanced),
    // not just the flat MeshCollection (these occurrences left the flat path).
    session.pendingInstancedOccurrences += partitioned.instancedOccurrences ?? 0;
  } finally {
    // Free the now-empty PartitionedBatch wrapper (its contents were moved out).
    partitioned.free?.();
  }
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

    // Cold-load lever 1c: install this worker's source bytes on the IfcAPI ONCE
    // per instance so the batch reads the file from the wasm heap instead of the
    // glue re-mallocing + memcpying the whole file on every call (~4 ms/call on
    // 169 MB; 600+ calls/worker on huge CSG-dense models). The bytes are the same
    // across a worker's calls (one model per worker), so one copy suffices and the
    // meshing reads the exact same bytes -> byte-identical output. A SAB-rejecting
    // runtime throws inside setSourceBytes during the copy, exactly as the legacy
    // per-call path would; the catch below materialises + retries, and the retry
    // re-installs the copy from the materialised buffer.
    cachedSourceBytes = session.localBytes;
    applySourceBytesToApi();

    // Instanced-only path: produce geometry ONCE via a partitioned batch, which
    // splits each batch into flat meshes (transparent + type-template + textured)
    // and an IFNS instancing shard (opaque, untextured ordinary occurrences). The
    // upload/memory/draw win is realised because instanced occurrences are taken
    // OFF the flat path entirely.
    //
    // Path selection, most-preferred first:
    //  1. processGeometryBatchPartitionedFromSource — lever 1c, no per-call copy;
    //  2. processGeometryBatchFromSource — flat, no per-call copy (federated /
    //     instancing off);
    //  3. processGeometryBatchPartitioned — legacy per-call copy (older wasm, or
    //     a SAB reject before materialise left the source uninstalled);
    //  4. processGeometryBatch — legacy flat per-call copy, the final fallback so
    //     the viewer stays functional rather than throwing into recovery.
    const sourced = ifcApi as IfcAPIWithSourceBatch;
    const partitionedFromSourceFn = sourceBytesApplied
      ? sourced.processGeometryBatchPartitionedFromSource
      : undefined;
    const batchFromSourceFn = sourceBytesApplied ? sourced.processGeometryBatchFromSource : undefined;
    const partitionedFn = (ifcApi as unknown as {
      processGeometryBatchPartitioned?: (...args: unknown[]) => PartitionedBatchResult;
    }).processGeometryBatchPartitioned;

    if (typeof partitionedFromSourceFn === 'function' && instancingEnabled) {
      consumePartitioned(session, partitionedFromSourceFn.call(
        ifcApi, jobs, session.unitScale,
        session.rtcX, session.rtcY, session.rtcZ, session.needsShift,
        session.voidKeys, session.voidCounts, session.voidValues,
        session.styleIds, session.styleColors, session.planeAngleToRadians,
        session.materialElementIds, session.materialColorCounts, session.materialColors,
      ));
    } else if (typeof batchFromSourceFn === 'function') {
      collectMeshes(session, batchFromSourceFn.call(
        ifcApi, jobs, session.unitScale,
        session.rtcX, session.rtcY, session.rtcZ, session.needsShift,
        session.voidKeys, session.voidCounts, session.voidValues,
        session.styleIds, session.styleColors, session.planeAngleToRadians,
        session.materialElementIds, session.materialColorCounts, session.materialColors,
      ));
    } else if (typeof partitionedFn === 'function' && instancingEnabled) {
      consumePartitioned(session, partitionedFn.call(
        ifcApi, session.localBytes, jobs, session.unitScale,
        session.rtcX, session.rtcY, session.rtcZ, session.needsShift,
        session.voidKeys, session.voidCounts, session.voidValues,
        session.styleIds, session.styleColors, session.planeAngleToRadians,
        session.materialElementIds, session.materialColorCounts, session.materialColors,
      ));
    } else {
      const collection = ifcApi.processGeometryBatch(
        session.localBytes, jobs, session.unitScale,
        session.rtcX, session.rtcY, session.rtcZ, session.needsShift,
        session.voidKeys, session.voidCounts, session.voidValues,
        session.styleIds, session.styleColors,
        session.planeAngleToRadians,
        session.materialElementIds, session.materialColorCounts, session.materialColors,
      );
      collectMeshes(session, collection);
    }
  } catch (err) {
    const msg = (err as Error).message;
    // The recovery below issues more synchronous WASM work — a SAB-fallback
    // re-decode, two binary-split halves, or a per-entity WASM re-init — none
    // of which feed the host watchdog on their own. A cluster of failing
    // entities could therefore blow the silent-window budget invisibly
    // (#1097, secondary window). Ping liveness before we recurse / re-init.
    postWorkerHeartbeat();
    if (!session.sabFallbackTaken && session.localBytes.buffer instanceof SharedArrayBuffer) {
      session.sabFallbackTaken = true;
      console.warn(`[Worker] processGeometryBatch rejected SAB view (${msg}), falling back to copy`);
      session.localBytes = materialiseSharedBytes(session.sharedBuffer);
      // The source was installed (or attempted) from the SAB view; re-install it
      // from the materialised copy on the retry so the *FromSource path reads the
      // exact same bytes (this replaces any partial/failed SAB-view install).
      cachedSourceBytes = session.localBytes;
      sourceBytesApplied = false;
      await processBatch(session, jobs);
      return;
    }
    if (numJobs === 1) {
      console.warn(`[Worker] Skipping entity #${jobs[0]}: ${msg}`);
      // Free the abandoned instance NOW rather than waiting for GC: it holds a
      // file-sized source copy (setSourceBytes), and `ensureInit` immediately
      // installs a fresh one — so a bare `api = null` would transiently double the
      // source in this worker's (never-shrinking) wasm heap on exactly the
      // memory-stressed models that trigger recovery. `free()` returns the block
      // to the wasm allocator so the re-install reuses it.
      try { api?.free(); } catch { /* wrapper may already be invalid */ }
      api = null;
      return;
    }
    console.warn(`[Worker] Batch of ${numJobs} entities failed (${msg}), splitting…`);
    try { api?.free(); } catch { /* see the free() rationale above */ }
    api = null;
    const mid = Math.floor(numJobs / 2) * 3;
    await processBatch(session, jobs.slice(0, mid));
    await processBatch(session, jobs.slice(mid));
  }
}

/** Run a slice in adaptive-sized chunks, flushing after each chunk. */
async function processSliceStreaming(session: ProcessingSession, jobsFlat: Uint32Array): Promise<void> {
  const totalJobs = Math.floor(jobsFlat.length / 3);
  let jobOffset = 0;
  while (jobOffset < totalJobs) {
    const batchJobs = Math.max(batchSizing.minJobs, Math.min(batchSizing.maxJobs, adaptiveBatchJobs));
    // Liveness heartbeat BEFORE entering the synchronous WASM call: the host
    // forwards it as a `progress` stream event so the consumer's stall
    // watchdog measures "time inside one bounded WASM call", not "time since
    // the last mesh" — a CSG-heavy region can legitimately produce nothing
    // for several seconds while every worker is busy. Also covers batches
    // that produce zero meshes (flushPending no-ops on empty).
    (self as unknown as Worker).postMessage(
      { type: 'progress', processedJobs: jobOffset, totalJobs } as GeometryWorkerProgressMessage,
    );
    const start = jobOffset * 3;
    const end = Math.min(start + batchJobs * 3, jobsFlat.length);
    const jobsThisBatch = (end - start) / 3;
    const callStart = performance.now();
    await processBatch(session, jobsFlat.subarray(start, end));
    flushPending(session);
    // Resize the next call from this one's measured throughput so the silent
    // window stays near TARGET_BATCH_MS regardless of CSG density (#1097).
    adaptiveBatchJobs = nextAdaptiveBatchJobs(
      adaptiveBatchJobs,
      jobsThisBatch,
      performance.now() - callStart,
      batchSizing,
    );
    jobOffset += jobsThisBatch;
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
  // The aggregate per-load console summary is logged once by the parallel loader
  // (geometry-parallel.ts), which holds the cross-worker total. This worker only
  // forwards its own subtotal on the message; logging here would print one partial
  // line per worker.
  (self as unknown as Worker).postMessage(
    {
      type: 'complete',
      totalMeshes: session.totalMeshesEmitted,
      ...(session.diagnostics ? { diagnostics: session.diagnostics } : {}),
    } as GeometryWorkerCompleteMessage,
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
    if (e.data.type === 'resolve-styles-shard') {
      // Sharded pre-pass: resolve this worker's styled-item slice against the
      // entity index installed by the preceding set-entity-index (FIFO).
      const ifcApi = await ensureInit();
      const { sharedBuffer, sliceIndex, spans } = e.data;
      try {
        const styleApi = (ifcApi as unknown as {
          resolveStyledItemsShard: (data: Uint8Array, spans: Uint32Array) => {
            orphanIds: Uint32Array; orphanColors: Float32Array;
            geomIds: Uint32Array; geomColors: Float32Array;
          };
        });
        let res;
        try {
          res = styleApi.resolveStyledItemsShard(viewSharedBytes(sharedBuffer), spans);
        } catch {
          // SAB-view rejection fallback (see scan-shard above).
          res = styleApi.resolveStyledItemsShard(materialiseSharedBytes(sharedBuffer), spans);
        }
        (self as unknown as Worker).postMessage(
          {
            type: 'styles-shard-result',
            sliceIndex,
            orphanIds: res.orphanIds,
            orphanColors: res.orphanColors,
            geomIds: res.geomIds,
            geomColors: res.geomColors,
          } as GeometryWorkerStylesShardResultMessage,
          [res.orphanIds.buffer, res.orphanColors.buffer, res.geomIds.buffer, res.geomColors.buffer],
        );
      } catch (err) {
        (self as unknown as Worker).postMessage({
          type: 'styles-shard-result',
          sliceIndex,
          orphanIds: new Uint32Array(0),
          orphanColors: new Float32Array(0),
          geomIds: new Uint32Array(0),
          geomColors: new Float32Array(0),
          error: err instanceof Error ? err.message : String(err),
        } as GeometryWorkerStylesShardResultMessage);
      }
      return;
    }

    if (e.data.type === 'prepass-streaming-sharded') {
      // Sharded pre-pass main call: prebuilt (stitched) index, external styles.
      const ifcApi = await ensureInit();
      (self as unknown as Worker).postMessage({ type: 'prepass-progress', phase: 'parsing' });
      const { sharedBuffer, indexIds, indexStarts, indexLengths, indexClasses } = e.data;
      const chunkSize = e.data.chunkSize ?? 50_000;
      const disabledTypes = e.data.disabledTypes ?? undefined;
      const skipTypeGeometry = e.data.skipTypeGeometry === true;
      const onEvent = (event: unknown) => {
        (self as unknown as Worker).postMessage({ type: 'prepass-stream', event });
      };
      const run = (
        bytes: Uint8Array,
        ids: Uint32Array, starts: Uint32Array, lengths: Uint32Array, classes: Uint8Array,
      ) =>
        (ifcApi as unknown as {
          buildPrePassStreamingSharded: (
            data: Uint8Array, onEvent: (e: unknown) => void, chunkSize: number,
            disabledTypes: string[] | undefined, skipTypeGeometry: boolean,
            ids: Uint32Array, starts: Uint32Array, lengths: Uint32Array, classes: Uint8Array,
          ) => unknown;
        }).buildPrePassStreamingSharded(
          bytes, onEvent, chunkSize, disabledTypes, skipTypeGeometry,
          ids, starts, lengths, classes,
        );
      try {
        run(viewSharedBytes(sharedBuffer), indexIds, indexStarts, indexLengths, indexClasses);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Worker] Sharded streaming prepass with SAB view failed (${msg}), retrying with copy`);
        try {
          // The id/start/length columns are SAB-backed too (zero-copy stitch
          // delivery), so a SAB-view rejection needs them materialised along
          // with the file bytes — `.slice()` of a SAB view yields a plain copy.
          run(
            materialiseSharedBytes(sharedBuffer),
            indexIds.slice(), indexStarts.slice(), indexLengths.slice(), indexClasses.slice(),
          );
        } catch (retryErr) {
          throw largeFilePrepassError(retryErr, sharedBuffer.byteLength) ?? retryErr;
        }
      }
      return;
    }

    if (e.data.type === 'finalize-styles') {
      // Sharded pre-pass epilogue: canonical merge + flatten of the shard-
      // resolved styled maps against the support spans. Runs on a GEOMETRY
      // worker (independent of the busy pre-pass worker); the host forwards
      // the payload into the normal styles-event path.
      const ifcApi = await ensureInit();
      const m = e.data;
      const finalizeApi = (ifcApi as unknown as {
        finalizePrepassStyles: (
          data: Uint8Array,
          orphanIds: Uint32Array, orphanColors: Float32Array,
          geomIds: Uint32Array, geomColors: Float32Array,
          colourMapSpans: Uint32Array, materialDefSpans: Uint32Array,
          relMaterialSpans: Uint32Array, voidSpans: Uint32Array,
          fillsSpans: Uint32Array, aggregateSpans: Uint32Array,
          planeAngleToRadians: number,
        ) => Record<string, unknown>;
      });
      const callFinalize = (bytes: Uint8Array) => finalizeApi.finalizePrepassStyles(
        bytes, m.orphanIds, m.orphanColors, m.geomIds, m.geomColors,
        m.colourMapSpans, m.materialDefSpans, m.relMaterialSpans,
        m.voidSpans, m.fillsSpans, m.aggregateSpans, m.planeAngleToRadians,
      );
      let payload;
      try {
        payload = callFinalize(viewSharedBytes(m.sharedBuffer));
      } catch {
        // SAB-view rejection fallback (see scan-shard above).
        payload = callFinalize(materialiseSharedBytes(m.sharedBuffer));
      }
      (self as unknown as Worker).postMessage({ type: 'styles-final', payload });
      return;
    }

    if (e.data.type === 'prepass-streaming') {
      const ifcApi = await ensureInit();
      // Heartbeat: lets the host watchdog know the worker is alive even
      // before the first chunk lands.
      (self as unknown as Worker).postMessage({ type: 'prepass-progress', phase: 'parsing' });
      const sharedBuffer = e.data.sharedBuffer;
      const chunkSize = e.data.chunkSize ?? 50_000;
      // #1097 load-time visibility filter (skip disabled types at job gen).
      const disabledTypes = e.data.disabledTypes ?? undefined;
      const skipTypeGeometry = e.data.skipTypeGeometry === true;

      // Forward Rust events 1:1 — the host (`geometry-parallel.ts`) treats
      // them as the streaming-prepass protocol. SAB-decode fallback: try the
      // zero-copy view first, fall back to a materialised copy only if
      // wasm-bindgen rejects the view.
      const onEvent = (event: unknown) => {
        (self as unknown as Worker).postMessage({ type: 'prepass-stream', event });
      };
      const runPrepass = (bytes: Uint8Array) =>
        ifcApi.buildPrePassStreaming(bytes, onEvent, chunkSize, disabledTypes, skipTypeGeometry);
      try {
        // Zero-copy SAB view first; wasm-bindgen copies it into linear memory.
        runPrepass(viewSharedBytes(sharedBuffer));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Worker] Streaming prepass with SAB view failed (${msg}), retrying with copy`);
        try {
          runPrepass(materialiseSharedBytes(sharedBuffer));
        } catch (retryErr) {
          // Both paths trapped — on a very large model this is the wasm32 4GB
          // limit; surface an actionable error instead of `unreachable executed`.
          throw largeFilePrepassError(retryErr, sharedBuffer.byteLength) ?? retryErr;
        }
      }
      return;
    }

    if (e.data.type === 'scan-shard') {
      // SPIKE (sharded pre-pass): scan this worker's byte range of the file and
      // post the entity-index columns + handoff back for main-thread stitching.
      // Runs while the worker is otherwise idle (before stream-start).
      const ifcApi = await ensureInit();
      const { sharedBuffer, shardIndex, rangeStart, rangeEnd } = e.data;
      const view = viewSharedBytes(sharedBuffer);
      const scanApi = (ifcApi as unknown as {
        scanEntityIndexShard: (
          data: Uint8Array,
          rangeStart: number,
          rangeEnd: number,
        ) => { ids: Uint32Array; starts: Uint32Array; lengths: Uint32Array; classes: Uint8Array; handoff: number };
      });
      let shard;
      try {
        shard = scanApi.scanEntityIndexShard(view, rangeStart, rangeEnd);
      } catch {
        // Some runtimes reject SAB-backed views at the wasm boundary (same
        // fallback the streaming pre-pass ships) — retry with a copy.
        shard = scanApi.scanEntityIndexShard(materialiseSharedBytes(sharedBuffer), rangeStart, rangeEnd);
      }
      (self as unknown as Worker).postMessage(
        {
          type: 'shard-result',
          shardIndex,
          ids: shard.ids,
          starts: shard.starts,
          lengths: shard.lengths,
          classes: shard.classes,
          handoff: shard.handoff,
        } as GeometryWorkerShardResultMessage,
        [shard.ids.buffer, shard.starts.buffer, shard.lengths.buffer, shard.classes.buffer],
      );
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
        skipSmallCutsApplied = false;
        applySkipSmallCutsToApi();
        entityIndexApplied = false;
        applyEntityIndexToApi();
        prepassColumnsApplied = false;
        applyPrepassColumnsToApi();
        sourceBytesApplied = false;
        applySourceBytesToApi();
      } else {
        await ensureInit();
      }
      (self as unknown as Worker).postMessage({ type: 'ready' });
      return;
    }

    if (e.data.type === 'stream-start') {
      await ensureInit();
      // Fresh load: re-resolve the (optionally overridden) sizing config and
      // relearn batch sizing from scratch (a reused worker may carry a small
      // size from a previous dense model).
      batchSizing = resolveBatchSizing(e.data.batchSizing);
      adaptiveBatchJobs = batchSizing.maxJobs;
      // Fresh load: drop any source held for a PREVIOUS load so this load's bytes
      // are re-installed on its first batch. The in-repo host spawns a fresh
      // worker per load so this is belt-and-braces there, but a host that reuses a
      // worker across loads without a `stream-end` between them would otherwise
      // mesh the new load against the previous file's held bytes (a similar-size
      // stale source decodes wrong entities). Resetting here makes that misuse
      // fail to the byte-identical legacy path instead of silently meshing wrong.
      sourceBytesApplied = false;
      cachedSourceBytes = null;
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
      await ensureInit();
      // Cache then apply via the replay helper so a later recovery re-init
      // (api = null in processBatch) re-installs the index instead of falling
      // back to the lazy O(file) re-scan (#1097).
      cachedEntityIndex = { ids: e.data.ids, starts: e.data.starts, lengths: e.data.lengths };
      entityIndexApplied = false;
      applyEntityIndexToApi();
      // Re-install any already-cached columns: setEntityIndex just cleared them.
      prepassColumnsApplied = false;
      applyPrepassColumnsToApi();
      return;
    }

    if (e.data.type === 'set-prepass-columns') {
      // Install the three per-content structures the pre-pass computed once
      // (issue #957 / #563) so this worker's first batch skips its own
      // full-file rebuild. Cache-and-replay like set-entity-index so a
      // recovery re-init re-installs them. Applied AFTER the entity index
      // (whose setter clears these caches); the pre-pass emits this event
      // after `entity-index`, and the worker handles messages FIFO, so the
      // ordering holds. Absent setters (older engine) ⇒ lazy rebuild fallback.
      await ensureInit();
      cachedPrepassColumns = e.data;
      prepassColumnsApplied = false;
      applyPrepassColumnsToApi();
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
    if (e.data.type === 'set-instancing-enabled') {
      // Default on; the host disables it for federated loads so their geometry stays
      // on the flat path (processBatch falls back to plain processGeometryBatch).
      instancingEnabled = e.data.enabled === true;
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

    if (e.data.type === 'set-skip-small-cuts') {
      // Same cache-and-replay contract as set-merge-layers (issue #1286).
      skipSmallCuts = e.data.enabled === true;
      skipSmallCutsApplied = false;
      applySkipSmallCutsToApi();
      return;
    }

    if (e.data.type === 'stream-end') {
      if (!activeSession) {
        throw new Error('stream-end received before stream-start');
      }
      emitSessionEnd(activeSession);
      activeSession = null;
      // Release the per-load entity index and drop the applied flag. Workers
      // are normally terminated after a load, but a reused worker must not
      // retain the (large) index buffers across loads, nor replay a stale
      // index on a recovery re-init before the next load's set-entity-index
      // arrives. The next load re-populates via its own set-entity-index.
      cachedEntityIndex = null;
      entityIndexApplied = false;
      // Same rationale for the per-content pre-pass columns: drop them so a
      // reused worker cannot replay a previous load's referenced-repmaps /
      // material-layer index. The next load re-populates via set-prepass-columns.
      cachedPrepassColumns = null;
      prepassColumnsApplied = false;
      // Release this worker's reference to the session source bytes and drop the
      // applied flag. The wasm-side copy is reclaimed on worker termination (the
      // pool is per-load) or overwritten by the next load's setSourceBytes on a
      // reused instance; mirrors the entity index.
      cachedSourceBytes = null;
      sourceBytesApplied = false;
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage(
      { type: 'error', message: err instanceof Error ? err.message : String(err) } as GeometryWorkerErrorMessage,
    );
  }
}
