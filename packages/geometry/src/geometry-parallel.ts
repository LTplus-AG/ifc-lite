/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Multi-worker parallel geometry processing with streaming pre-pass.
 *
 * Architecture:
 *   1. Spawn a single "pre-pass" worker that runs the WASM streaming
 *      scanner. The scanner walks the file once and emits:
 *        - `meta`     once, when RTC + unit are resolved (~1-2 % of scan)
 *        - `jobs`     repeatedly, every ~50 K entities
 *        - `complete` once, when the scan finishes
 *   2. On `meta`: spawn N geometry process workers (memory-budget-aware
 *      count) and send each a `stream-start` so they hold the metadata
 *      before any chunk arrives.
 *   3. On each `jobs` chunk: round-robin the chunk to a worker via
 *      `stream-chunk`. Workers process and emit `batch` messages.
 *   4. On `complete`: send `stream-end` to each worker so they emit
 *      their final `batch`/`memory`/`complete`.
 *
 * Net effect for a 1 GB file: time-to-first-batch drops from ~17 s
 * (full pre-pass + worker spawn + first batch) to ~3-5 s (pre-pass
 * scans first 100 K bytes → meta → first chunk → first batch).
 */

import type { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData, TessellationQuality } from './types.js';
import type { StreamingGeometryEvent } from './index.js';
import { mergeGeometryDiagnostics, type GeometryDiagnostics } from './diagnostics.js';
import { computeWorkerCount } from './worker-count.js';
import type { BatchSizingConfig } from './batch-sizing.js';
import { notifyIfWasmAssetUnavailable } from './wasm-asset-error.js';

/**
 * Plan content-affinity routing for one chunk: assign each job (by index) to a
 * worker bucket so that every job sharing an affinity key lands on the SAME
 * worker — across the whole stream, since `keyToWorker` is the caller's sticky
 * map. New keys are handed out round-robin from `startWorker`, so each worker
 * owns roughly `1/workerCount` of the distinct keys (≈ distinct geometries, the
 * dominant meshing cost). Pure: mutates only the passed `keyToWorker` and returns
 * the advanced round-robin cursor. (#1130 follow-up — see `affinity_key` in Rust.)
 */
export function planAffinityRouting(
  affinity: Uint32Array,
  totalJobs: number,
  workerCount: number,
  keyToWorker: Map<number, number>,
  startWorker: number,
): { buckets: number[][]; nextWorker: number } {
  const buckets: number[][] = Array.from({ length: workerCount }, () => []);
  let nextWorker = startWorker % workerCount;
  for (let j = 0; j < totalJobs; j++) {
    const key = affinity[j];
    let w = keyToWorker.get(key);
    if (w === undefined) {
      w = nextWorker;
      nextWorker = (nextWorker + 1) % workerCount;
      keyToWorker.set(key, w);
    }
    buckets[w].push(j);
  }
  return { buckets, nextWorker };
}

/**
 * Optional runtime override for the geometry worker's adaptive batch sizing
 * (#1097), read off `globalThis` on the host thread. A zero-cost escape hatch
 * for hardware-specific tuning / field-debugging the watchdog↔throughput
 * trade-off without a rebuild; unset ⇒ the worker uses DEFAULT_BATCH_SIZING.
 * Validation/merge happens in the worker via `resolveBatchSizing`.
 */
function readBatchSizingOverride(): Partial<BatchSizingConfig> | undefined {
  const g = globalThis as unknown as { __IFC_LITE_BATCH_SIZING?: Partial<BatchSizingConfig> };
  const v = g.__IFC_LITE_BATCH_SIZING;
  return v && typeof v === 'object' ? v : undefined;
}

/**
 * Optional load-time visibility filter (#1097), read off `globalThis` on the
 * host thread (tuning / benchmarking escape hatch). `{ disabledTypes,
 * skipTypeGeometry }` skip the matching geometry jobs at the prepass so they're
 * never decoded/meshed/uploaded. Unset ⇒ load everything.
 */
function readVisibilityFilterOverride(): { disabledTypes?: string[]; skipTypeGeometry?: boolean } | undefined {
  const g = globalThis as unknown as {
    __IFC_LITE_VISIBILITY_FILTER?: { disabledTypes?: string[]; skipTypeGeometry?: boolean };
  };
  const v = g.__IFC_LITE_VISIBILITY_FILTER;
  return v && typeof v === 'object' ? v : undefined;
}

interface PrepassMeta {
  /** Prepass-resolved plane-angle→radians scale; seeds worker batch decoders. */
  planeAngleToRadians?: number;
  unitScale: number;
  rtcOffset: Float64Array;
  needsShift: boolean;
  buildingRotation?: number | null;
}

export interface ProcessParallelOptions {
  /**
   * Fires when the streaming pre-pass finishes building the entity index
   * (after styles), with SAB-backed Uint32Array views over the shared
   * column buffers. The parser worker uses this to skip its own
   * `scanEntitiesFastBytes` call (~10 s on 1 GB files under WASM
   * contention with the geometry workers).
   */
  onEntityIndex?: (
    ids: Uint32Array,
    starts: Uint32Array,
    lengths: Uint32Array,
  ) => void;
  /**
   * Issue #540 — "Merge Multilayer Walls" load-time toggle. When
   * `true`, the geometry workers' IfcAPI receive
   * `setMergeLayers(true)` before the first stream-chunk lands, so
   * Revit-style multilayer-wall part meshes are suppressed at the
   * Rust layer. Default `false` keeps existing behaviour.
   */
  mergeLayers?: boolean;
  /**
   * GPU-instancing partition toggle (default true). Set false for FEDERATED loads:
   * the instanced render path is primary-model only, so a federated model must keep
   * all geometry on the flat path or its opaque repeated occurrences are dropped.
   */
  enableInstancing?: boolean;
  /**
   * Issue #924 — per-entity geometry-hash tolerance in metres. When a
   * positive value is given, each geometry worker's IfcAPI receives
   * `setComputeGeometryHashes(tol)` before the first stream-chunk, so the
   * RTC-invariant `geometryHash` lands on every emitted mesh for the
   * model-diff / compare feature. `undefined`/`null` ⇒ off (zero overhead).
   */
  geometryHashTolerance?: number | null;
  /**
   * Issue #976 — tessellation detail level for curved geometry. When set,
   * each geometry worker's IfcAPI receives `setTessellationQuality(level)`
   * before the first stream-chunk. `undefined`/`null` ⇒ engine default
   * (`'medium'`, output identical to the pre-quality pipeline).
   */
  tessellationQuality?: TessellationQuality | null;
  /**
   * Issue #1286 — tier-independent small-cut skip. When true, each geometry
   * worker's IfcAPI receives `setSkipSmallCuts(true)` before the first
   * stream-chunk, dropping tiny `IfcBooleanResult` detail cuts while keeping the
   * tessellation tier. `undefined`/`false` ⇒ every cut runs (default).
   */
  skipSmallCuts?: boolean;
  /**
   * Explicit URL for the wasm-bindgen `.wasm` binary. When provided,
   * forwarded to the geometry workers' init messages so they call
   * `init(wasmUrl)` instead of relying on wasm-bindgen's default
   * `import.meta.url`-based resolution.
   *
   * Vite + webpack 5 consumers don't need to set this — the bundler
   * rewrites the `new URL('ifc-lite_bg.wasm', import.meta.url)` literal
   * inside the wasm-bindgen glue at build time. This option exists for
   * consumers whose bundler doesn't transform that pattern, or who
   * serve the wasm from a CDN at a different origin (e.g., self-hosted
   * deployments, Tauri custom protocols, embedded usage).
   */
  wasmUrls?: {
    wasm?: string;
  };
  /**
   * Issue #1097 — optional override for the worker's adaptive batch sizing
   * (the watchdog↔throughput knob). Takes precedence over the `globalThis`
   * tuning hook; omitted ⇒ `DEFAULT_BATCH_SIZING`. Forwarded to every worker
   * in its `stream-start` message and validated there.
   */
  batchSizing?: Partial<BatchSizingConfig>;
  /**
   * #1097 load-time visibility filter. `disabledTypes` (uppercase STEP keywords)
   * and `skipTypeGeometry` are forwarded to the prepass so the matching geometry
   * jobs are never produced — cutting decode + CSG + tessellation + upload for
   * hidden types (spaces/annotations/grids/type-library). Takes precedence over
   * the `globalThis.__IFC_LITE_VISIBILITY_FILTER` hook. Toggling a type back on
   * requires a reload.
   */
  visibilityFilter?: { disabledTypes?: string[]; skipTypeGeometry?: boolean };
  /**
   * Explicit geometry-worker count for A/B tuning (the viewer's
   * `?geomWorkers=N` knob). Overrides the cores-tier heuristic but stays
   * clamped to the memory budget — see {@link computeWorkerCount}. `undefined`
   * ⇒ use the heuristic. Lets a user measure their host's true thermal optimum
   * (which is machine-specific). Geometry output is unaffected by the count
   * (workers process disjoint, deterministic element slices).
   */
  workerCountOverride?: number;
}

export async function* processParallel(
  buffer: Uint8Array,
  coordinator: CoordinateHandler,
  sharedRtcOffset?: { x: number; y: number; z: number },
  /** Optional pre-allocated SAB the caller already shares with another worker. */
  existingSab?: SharedArrayBuffer,
  options?: ProcessParallelOptions,
): AsyncGenerator<StreamingGeometryEvent> {
  coordinator.reset();

  yield { type: 'start', totalEstimate: buffer.length / 1000 };
  yield { type: 'model-open', modelID: 0 };

  // SAB sharing — see Tier-1 / fix-RAM history. Three paths:
  //   1. Caller-supplied SAB.
  //   2. Input `buffer` already views a SAB.
  //   3. Allocate fresh SAB and copy.
  let sharedBuffer: SharedArrayBuffer;
  const inputBuffer = buffer.buffer;
  if (existingSab && existingSab.byteLength === buffer.byteLength) {
    sharedBuffer = existingSab;
  } else if (
    typeof SharedArrayBuffer !== 'undefined'
    && inputBuffer instanceof SharedArrayBuffer
    && buffer.byteOffset === 0
    && buffer.byteLength === inputBuffer.byteLength
  ) {
    sharedBuffer = inputBuffer;
  } else {
    sharedBuffer = new SharedArrayBuffer(buffer.byteLength);
    new Uint8Array(sharedBuffer).set(buffer);
  }

  // N independent WASM-instance workers, each running
  // `geometry.worker.ts` (one `@ifc-lite/wasm` instance per worker).
  const makeGeometryWorker = () =>
    new Worker(
      new URL('./geometry.worker.ts', import.meta.url),
      { type: 'module' },
    );
  const makePrepassWorker = () => new Worker(
    new URL('./geometry.worker.ts', import.meta.url),
    { type: 'module' },
  );

  // Shared aggregator state used by every worker callback below.
  const eventQueue: StreamingGeometryEvent[] = [];
  let resolveWaiting: (() => void) | null = null;
  const wake = () => {
    if (resolveWaiting) {
      resolveWaiting();
      resolveWaiting = null;
    }
  };

  // Pre-pass worker drives the entire pipeline via streaming events.
  let prepassMeta: PrepassMeta | null = null;
  let prepassJobsTotal = 0;
  let prepassDone = false;
  let prepassError: Error | null = null;

  // Process-worker pool — spawned UP FRONT so their WASM modules compile
  // in parallel with the pre-pass scan. By the time `meta` arrives the
  // workers are usually hot and the first chunk's processing time is
  // dominated by actual geometry work, not WASM startup.
  let workerError: Error | null = null;
  let workersCompleted = 0;
  let totalMeshes = 0;
  // CSG / opening diagnostics merged across all workers, forwarded on the final
  // completion event so loadFile callers can read a typed per-load summary.
  let diagnostics: GeometryDiagnostics | null = null;
  let endSentToWorkers = false;
  let streamStartSentToWorkers = false;
  /**
   * Chunks held until BOTH `meta` (workers spawned + initialised) AND
   * `styles` (resolved colours from the pre-pass) have arrived. Workers
   * process every chunk with non-empty styles, giving uniform colours
   * across the entire stream — early chunks that were previously
   * processed with empty styles + retroactive colorUpdate didn't recolour
   * geometry-style meshes (geometry-IDs don't match the host's
   * mesh.expressId; only element-material colours did).
   */
  const queuedChunks: { jobs: Uint32Array; affinity: Uint32Array | null }[] = [];
  let stylesReceived = false;
  let entityIndexReceived = false;

  // Content-affinity routing (#1130 follow-up): the pre-pass tags every job with
  // an affinity key (ObjectType hash, see `affinity_key` in Rust). Sending all
  // jobs of one key to the SAME worker means each unique geometry is meshed ONCE
  // per model — the per-worker content-dedup cache then turns the rest into cheap
  // hits — instead of every worker re-meshing the full unique set (the cap of
  // PR #1130 on its own). `keyToWorker` is sticky for the whole stream; new keys
  // round-robin so each worker owns ~1/N of the distinct geometries (the dominant
  // cost). Falls back to interleaving when the pre-pass sends no affinity array.
  const keyToWorker = new Map<number, number>();
  let nextAffinityWorker = 0;

  // Per-worker first-batch timestamps (filled lazily so we don't need
  // workerCount at this point). The closure indexes by workerIndex.
  const firstBatchByWorker: number[] = [];
  const installWorkerHandlers = (worker: Worker, workerIndex: number) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        console.log(`[stream] worker[${workerIndex}] WASM ready @ ${elapsed()}ms`);
        return;
      }
      if (msg.type === 'memory') {
        eventQueue.push({
          type: 'workerMemory',
          workerIndex,
          wasmHeapBytes: msg.wasmHeapBytes,
          meshBytes: msg.meshBytes,
        });
        wake();
        return;
      }
      if (msg.type === 'progress') {
        // Worker liveness heartbeat, posted before each bounded WASM call.
        // Forward it so the consumer's stall watchdog measures "one WASM
        // call went silent", not "no meshes lately" — a CSG-heavy stretch
        // can keep every worker busy past the watchdog with nothing to show.
        eventQueue.push({ type: 'progress', phase: 'workers' });
        wake();
        return;
      }
      if (msg.type === 'batch') {
        if (firstBatchByWorker[workerIndex] === undefined) {
          firstBatchByWorker[workerIndex] = elapsed();
          console.log(`[stream] worker[${workerIndex}] first batch @ ${elapsed()}ms (${msg.meshes?.length ?? 0} meshes)`);
        }
        const meshes: MeshData[] = msg.meshes.map((m: {
          expressId: number;
          ifcType?: string;
          positions: Float32Array;
          normals: Float32Array;
          indices: Uint32Array;
          color: [number, number, number, number];
          shadingColor?: [number, number, number, number];
          // #961: optional per-vertex UVs + decoded surface texture.
          uvs?: MeshData['uvs'];
          texture?: MeshData['texture'];
          geometryHash?: bigint;
          geometryClass?: number;
          origin?: [number, number, number];
          localBounds?: MeshData['localBounds'];
          localToWorld?: MeshData['localToWorld'];
        }) => ({
          expressId: m.expressId,
          ifcType: m.ifcType,
          positions: m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions),
          normals: m.normals instanceof Float32Array ? m.normals : new Float32Array(m.normals),
          indices: m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices),
          color: m.color,
          // SurfaceColour for GLB "Shading" export (worker parity fix).
          ...(m.shadingColor ? { shadingColor: m.shadingColor } : {}),
          // #961: carry per-vertex UVs + decoded surface texture through to the
          // renderer (transferables; already typed arrays from the worker).
          ...(m.uvs ? { uvs: m.uvs } : {}),
          ...(m.texture ? { texture: m.texture } : {}),
          // Carry the model-diff fingerprint through the worker boundary
          // (issue #924); undefined when hashing is off.
          ...(m.geometryHash !== undefined ? { geometryHash: m.geometryHash } : {}),
          // #957 follow-up: carry the Model/Types geometry class through the
          // worker→main re-map (else the viewer's view-mode filter sees only
          // class 0 and the Types view renders nothing).
          ...(m.geometryClass !== undefined ? { geometryClass: m.geometryClass } : {}),
          // Per-element local-frame origin (world = origin + position); the
          // renderer reconstructs world via a per-batch model-matrix translate.
          ...(m.origin ? { origin: m.origin } : {}),
          // Local (pre-placement) AABB + placement transform (issue #1474).
          ...(m.localBounds ? { localBounds: m.localBounds } : {}),
          ...(m.localToWorld ? { localToWorld: m.localToWorld } : {}),
        }));
        // GPU-instancing: per-batch IFNS shards ride alongside the flat meshes.
        // Opaque repeated occurrences render ONLY via these shards (taken off the
        // flat `meshes` array), so their count must be folded into the running
        // total for an accurate `totalSoFar`.
        const instancedShards = (msg as { instancedShards?: ArrayBuffer[] }).instancedShards;
        const instancedOccurrences =
          (msg as { instancedOccurrences?: number }).instancedOccurrences ?? 0;
        // #924 compare parity: geometry-diff hashes for instanced-only entities
        // (no flat mesh carries them). Forward straight through to the consumer.
        const instancedGeometryHashIds =
          (msg as { instancedGeometryHashIds?: Uint32Array }).instancedGeometryHashIds;
        const instancedGeometryHashValues =
          (msg as { instancedGeometryHashValues?: BigUint64Array }).instancedGeometryHashValues;
        if (
          meshes.length > 0 ||
          (instancedShards && instancedShards.length > 0) ||
          (instancedGeometryHashIds && instancedGeometryHashIds.length > 0)
        ) {
          // Update totalMeshes per batch so consumers see a live
          // running count via `totalSoFar`. The `complete` event
          // below used to be the only updater, leaving streamed
          // batches reporting a stale total until the worker exited.
          if (meshes.length > 0) {
            totalMeshes += meshes.length;
            coordinator.processMeshesIncremental(meshes);
          }
          // Instanced occurrences left the flat array but are still rendered
          // geometry — count them so totalSoFar reflects the full model.
          totalMeshes += instancedOccurrences;
          const coordinateInfo = coordinator.getCurrentCoordinateInfo();
          eventQueue.push({
            type: 'batch',
            meshes,
            totalSoFar: totalMeshes,
            coordinateInfo: coordinateInfo || undefined,
            ...(instancedShards && instancedShards.length > 0 ? { instancedShards } : {}),
            ...(instancedGeometryHashIds && instancedGeometryHashIds.length > 0
              ? { instancedGeometryHashIds, instancedGeometryHashValues }
              : {}),
          });
          wake();
        }
        return;
      }
      if (msg.type === 'complete') {
        // Don't add msg.totalMeshes here — batches above already
        // updated `totalMeshes += meshes.length` per batch, so the
        // running sum is already correct. msg.totalMeshes is the
        // worker's per-session count; if it disagrees with the sum
        // of batch lengths we observed, a batch was lost — log but
        // trust our observed count to keep totalSoFar consistent
        // with what consumers actually rendered.
        diagnostics = mergeGeometryDiagnostics(diagnostics, msg.diagnostics);
        workersCompleted++;
        worker.terminate();
        wake();
        return;
      }
      if (msg.type === 'error') {
        // A rotated/missing engine binary after a redeploy (#1363) surfaces
        // here as the worker's wasm-init failure — let the host reload.
        notifyIfWasmAssetUnavailable(msg.message);
        workerError = new Error(`Geometry worker error: ${msg.message}`);
        workersCompleted++;
        worker.terminate();
        wake();
        return;
      }
    };
    worker.onerror = (err) => {
      // A hard worker crash (e.g. the wasm thread aborting under memory
      // pressure) fires an ErrorEvent with an empty `message`. Emitting the
      // literal "undefined" produced a cryptic, unclassifiable error in tracking
      // ("Geometry worker failed: undefined"). Synthesise a meaningful message
      // from whatever the ErrorEvent carries, defaulting to the most common
      // cause so the error classifier can bucket it.
      const detail =
        (err?.message && String(err.message)) ||
        (err?.filename ? `at ${err.filename}:${err.lineno ?? 0}` : '') ||
        'worker terminated unexpectedly';
      notifyIfWasmAssetUnavailable(detail);
      workerError = new Error(`Geometry worker failed: ${detail}`);
      workersCompleted++;
      worker.terminate();
      wake();
    };
  };

  // Pick worker count and pre-spawn them now. `computeWorkerCount` needs a
  // totalJobs estimate; use file-size proxy. The memory-budget cap in
  // `computeWorkerCount` keeps an over-estimate harmless, and still bounds an
  // explicit `workerCountOverride` so the A/B knob can't OOM the tab.
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  const deviceMemoryGB = typeof navigator !== 'undefined'
    ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) : 8;
  const fileSizeMB = buffer.byteLength / (1024 * 1024);
  const estimatedJobs = Math.max(1, Math.ceil(fileSizeMB * 100));
  const workerCountResult = computeWorkerCount({
    fileSizeMB,
    cores,
    deviceMemoryGB,
    totalJobs: estimatedJobs,
    workerCountOverride: options?.workerCountOverride,
  });
  const workerCount = workerCountResult.count;

  const workers: Worker[] = [];
  for (let i = 0; i < workerCount; i++) {
    const worker = makeGeometryWorker();
    workers.push(worker);
    installWorkerHandlers(worker, i);
    // Kick off WASM compile concurrently with the pre-pass scan. The
    // worker's tail-promise serialiser guarantees this `init` completes
    // before any subsequent `stream-start`/`stream-chunk` runs.
    //
    // `wasmUrl` is forwarded only when the consumer explicitly provided
    // one — undefined leaves the worker on wasm-bindgen's default
    // `import.meta.url`-based resolution, which is what Vite + webpack
    // already handle.
    const wasmUrlForWorker = options?.wasmUrls?.wasm;
    worker.postMessage({
      type: 'init',
      ...(wasmUrlForWorker ? { wasmUrl: wasmUrlForWorker } : {}),
    });
    // Issue #540: forward the user's "Merge Multilayer Walls" toggle
    // BEFORE any stream-start so the worker's IfcAPI has the flag set
    // before its first parse call. The tail-promise serialiser inside
    // each worker preserves this order even though the messages are
    // posted back-to-back. We always send the message so the controller
    // path doesn't have to remember whether the host called it — the
    // default `false` is a cheap no-op.
    worker.postMessage({
      type: 'set-merge-layers',
      enabled: options?.mergeLayers === true,
    });
    // GPU-instancing partition toggle — default ON; the host sets false for federated
    // loads so a federated model's geometry stays flat (instancing is primary-only).
    worker.postMessage({
      type: 'set-instancing-enabled',
      enabled: options?.enableInstancing !== false,
    });
    // Issue #924: forward the geometry-hash tolerance the same way — always
    // sent so the controller path stays uniform; null is a cheap no-op.
    worker.postMessage({
      type: 'set-compute-geometry-hashes',
      tolerance: options?.geometryHashTolerance ?? null,
    });
    // Issue #976: forward the tessellation-quality level the same way —
    // null keeps the Rust default (Medium / historical densities).
    worker.postMessage({
      type: 'set-tessellation-quality',
      level: options?.tessellationQuality ?? null,
    });
    // Issue #1286: forward the small-cut skip the same way — always sent so a
    // worker reused by a later export (which omits it) resets to false.
    worker.postMessage({
      type: 'set-skip-small-cuts',
      enabled: options?.skipSmallCuts === true,
    });
  }

  const sendStreamEnd = () => {
    if (endSentToWorkers) return;
    endSentToWorkers = true;
    for (const w of workers) {
      try {
        w.postMessage({ type: 'stream-end' });
      } catch { /* worker terminated already — safe to ignore */ }
    }
  };

  const sendStreamStartIfReady = () => {
    if (streamStartSentToWorkers || !prepassMeta) return;
    streamStartSentToWorkers = true;

    const useSharedRtc = sharedRtcOffset != null;
    const rtcX = useSharedRtc ? sharedRtcOffset.x : prepassMeta.rtcOffset[0];
    const rtcY = useSharedRtc ? sharedRtcOffset.y : prepassMeta.rtcOffset[1];
    const rtcZ = useSharedRtc ? sharedRtcOffset.z : prepassMeta.rtcOffset[2];
    const effectiveNeedsShift = useSharedRtc ? true : prepassMeta.needsShift;

    // Surface the world→render metadata (unit scale + the effective applied
    // RTC, which is the shared offset under federation) on coordinateInfo for
    // downstream consumers (issue #945).
    coordinator.setWasmMetadata(
      prepassMeta.unitScale,
      effectiveNeedsShift ? { x: rtcX, y: rtcY, z: rtcZ } : null,
    );

    eventQueue.push({
      type: 'rtcOffset',
      rtcOffset: { x: rtcX, y: rtcY, z: rtcZ },
      hasRtc: effectiveNeedsShift,
    });
    wake();

    const emptyU32 = new Uint32Array(0);
    const emptyU8 = new Uint8Array(0);
    const batchSizing = options?.batchSizing ?? readBatchSizingOverride();
    for (const worker of workers) {
      worker.postMessage({
        type: 'stream-start' as const,
        sharedBuffer,
        unitScale: prepassMeta.unitScale,
        planeAngleToRadians: prepassMeta.planeAngleToRadians,
        rtcX, rtcY, rtcZ,
        needsShift: effectiveNeedsShift,
        voidKeys: emptyU32,
        voidCounts: emptyU32,
        voidValues: emptyU32,
        styleIds: emptyU32,
        styleColors: emptyU8,
        ...(batchSizing ? { batchSizing } : {}),
      });
    }

    // Don't drain queued chunks here — wait for the `styles` event so
    // every chunk gets processed with resolved colours. The styles
    // handler does the drain after posting set-styles.
  };

  /**
   * Group a chunk's jobs by the worker each job's affinity key maps to, then
   * post one contiguous slice per worker. All jobs of a key reach the same
   * worker across the whole stream (`keyToWorker` is sticky), so each unique
   * geometry is meshed once; new keys round-robin for even spread.
   */
  function dispatchByAffinity(jobs: Uint32Array, affinity: Uint32Array): void {
    const n = workers.length;
    const totalSubJobs = Math.floor(jobs.length / 3);
    const { buckets, nextWorker } = planAffinityRouting(
      affinity,
      totalSubJobs,
      n,
      keyToWorker,
      nextAffinityWorker,
    );
    nextAffinityWorker = nextWorker;
    for (let i = 0; i < n; i++) {
      const idxs = buckets[i];
      if (idxs.length === 0) continue;
      const sub = new Uint32Array(idxs.length * 3);
      for (let k = 0, o = 0; k < idxs.length; k++, o += 3) {
        const src = idxs[k] * 3;
        sub[o] = jobs[src];
        sub[o + 1] = jobs[src + 1];
        sub[o + 2] = jobs[src + 2];
      }
      workers[i].postMessage(
        { type: 'stream-chunk' as const, jobsFlat: sub },
        [sub.buffer],
      );
    }
  }

  function dispatchJobsChunkInternal(jobs: Uint32Array, affinity: Uint32Array | null): void {
    if (workers.length === 0 || jobs.length === 0) return;
    const totalSubJobs = Math.floor(jobs.length / 3);
    if (totalSubJobs === 0) return;
    try {
      // Preferred path: content-affinity routing so each unique geometry is
      // meshed once per model rather than once per worker (#1130 follow-up).
      if (affinity && affinity.length === totalSubJobs) {
        dispatchByAffinity(jobs, affinity);
        return;
      }
      // Fallback (no affinity array): INTERLEAVED split — worker i takes jobs i,
      // i+N, i+2N, …. Geometric complexity clusters by file region, so striding
      // spreads any hot region across the pool instead of handing one worker the
      // entire heavy cluster while the rest go idle.
      for (let i = 0; i < workers.length; i++) {
        const subJobs = Math.floor((totalSubJobs - i + workers.length - 1) / workers.length);
        if (subJobs === 0) continue;
        // New ArrayBuffer per piece so each can be in its own transfer
        // list. Cheap relative to the WASM work that follows.
        const sub = new Uint32Array(subJobs * 3);
        for (let j = 0, src = i * 3; j < subJobs * 3; j += 3, src += workers.length * 3) {
          sub[j] = jobs[src];
          sub[j + 1] = jobs[src + 1];
          sub[j + 2] = jobs[src + 2];
        }
        workers[i].postMessage(
          { type: 'stream-chunk' as const, jobsFlat: sub },
          [sub.buffer],
        );
      }
    } catch (err) {
      workerError = new Error(`Failed to dispatch jobs chunk: ${err instanceof Error ? err.message : String(err)}`);
      wake();
    }
  }

  const dispatchJobsChunk = (jobs: Uint32Array, affinity: Uint32Array | null) => {
    if (!streamStartSentToWorkers || !stylesReceived || !entityIndexReceived) {
      // Hold until stream-start AND styles AND entity-index have all
      // been posted to workers. Without styles the meshes would render
      // with default per-type colours; without the pre-built entity
      // index, the worker's first WASM call would re-scan the file
      // (~5 s on 1 GB) to rebuild the index inside Rust.
      queuedChunks.push({ jobs, affinity });
      return;
    }
    dispatchJobsChunkInternal(jobs, affinity);
  };

  /** Drain queued chunks once all gating conditions are met. */
  const drainQueuedChunksIfReady = () => {
    if (!streamStartSentToWorkers || !stylesReceived || !entityIndexReceived) return;
    while (queuedChunks.length > 0) {
      const c = queuedChunks.shift()!;
      dispatchJobsChunkInternal(c.jobs, c.affinity);
    }
  };

  // Step-by-step timing so we can tell exactly where time goes.
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const overrideNote = options?.workerCountOverride != null
    ? ` (override=${options.workerCountOverride}, bound=${workerCountResult.reason})`
    : ` (cores=${cores}, bound=${workerCountResult.reason})`;
  console.log(`[stream] processParallel start, fileSizeMB=${fileSizeMB.toFixed(1)} workerCount=${workerCount}${overrideNote}`);

  const prepassWorker = makePrepassWorker();
  // Wrap the rest of the pipeline so worker teardown runs not only on
  // normal completion / error / zero-jobs branches, but also when the
  // consumer abandons the generator via `.return()` / `.throw()` while it
  // is suspended at a `yield` or the `resolveWaiting` await. The viewer's
  // `watchedGeometryStream` relies on this `finally` to tear down workers
  // on break / abort / watchdog (see boundedIteratorReturn). The existing
  // branch-local `terminate()` calls remain — `terminate()` is idempotent.
  try {
  // Forward the consumer-supplied wasm URL to the pre-pass worker so it
  // doesn't fall back to wasm-bindgen's `import.meta.url` default. The
  // pre-pass worker uses the same `geometry.worker.ts` bundle and the
  // legacy (non-threaded) wasm, so `wasmUrls.wasm` is the right key.
  // Skipped entirely when no URL was provided — keeps Vite/webpack
  // consumers on the bundler-native resolution path.
  if (options?.wasmUrls?.wasm) {
    prepassWorker.postMessage({ type: 'init', wasmUrl: options.wasmUrls.wasm });
  }
  let chunkArrivals = 0;
  let totalDispatchedJobs = 0;
  let firstChunkAt = -1;
  prepassWorker.onmessage = (e: MessageEvent) => {
    const data = e.data;
    if (data.type === 'prepass-progress') {
      eventQueue.push({ type: 'progress', phase: 'prepass' });
      wake();
      return;
    }
    if (data.type === 'prepass-stream') {
      const evt = data.event as { type: string; [k: string]: unknown };
      if (evt.type === 'meta') {
        prepassMeta = {
          unitScale: evt.unitScale as number,
          planeAngleToRadians: (evt.planeAngleToRadians as number | undefined) ?? undefined,
          rtcOffset: evt.rtcOffset as Float64Array,
          needsShift: evt.needsShift as boolean,
          buildingRotation: (evt.buildingRotation as number | null | undefined) ?? null,
        };
        console.log(`[stream] meta @ ${elapsed()}ms unitScale=${prepassMeta.unitScale} rtc=[${(prepassMeta.rtcOffset[0]).toFixed(0)},${(prepassMeta.rtcOffset[1]).toFixed(0)},${(prepassMeta.rtcOffset[2]).toFixed(0)}]`);
        sendStreamStartIfReady();
        wake();
      } else if (evt.type === 'jobs') {
        const jobsArr = evt.jobs as Uint32Array;
        // Parallel per-job affinity keys (#1130 follow-up). Absent on older
        // pre-pass builds → dispatcher falls back to interleaving.
        const affinityArr = (evt.affinity as Uint32Array | undefined) ?? null;
        const jobCount = Math.floor(jobsArr.length / 3);
        chunkArrivals++;
        totalDispatchedJobs += jobCount;
        if (firstChunkAt < 0) {
          firstChunkAt = elapsed();
          console.log(`[stream] first jobs chunk @ ${firstChunkAt}ms (${jobCount} jobs, affinity=${affinityArr ? 'on' : 'off'})`);
        }
        if (chunkArrivals % 10 === 1 || jobCount < 1000) {
          console.log(`[stream] chunk #${chunkArrivals} @ ${elapsed()}ms (+${jobCount} jobs, total ${totalDispatchedJobs})`);
        }
        dispatchJobsChunk(jobsArr, affinityArr);
      } else if (evt.type === 'styles') {
        // Streaming pre-pass resolved styles + voids after its main scan.
        // Push them into every worker, then drain any chunks that were
        // held waiting for styles. Workers will process every chunk with
        // resolved colors — uniform shading across the whole stream.
        const styleIds = evt.styleIds as Uint32Array;
        const styleColors = evt.styleColors as Uint8Array;
        const voidKeys = evt.voidKeys as Uint32Array;
        const voidCounts = evt.voidCounts as Uint32Array;
        const voidValues = evt.voidValues as Uint32Array;
        const materialElementIds = (evt.materialElementIds as Uint32Array | undefined) ?? new Uint32Array(0);
        const materialColorCounts = (evt.materialColorCounts as Uint32Array | undefined) ?? new Uint32Array(0);
        const materialColors = (evt.materialColors as Uint8Array | undefined) ?? new Uint8Array(0);
        console.log(`[stream] styles @ ${elapsed()}ms (${styleIds.length} styled, ${voidKeys.length} void hosts), draining ${queuedChunks.length} queued chunks`);

        for (const w of workers) {
          // Slice each typed array per-worker so each can be in its own
          // transfer list without conflict. The slice cost is bounded by
          // `styleIds.length * 4` bytes — under 1 MB for ~250K styles.
          try {
            const sIds = styleIds.slice();
            const sColors = styleColors.slice();
            const vKeys = voidKeys.slice();
            const vCounts = voidCounts.slice();
            const vValues = voidValues.slice();
            const mIds = materialElementIds.slice();
            const mCounts = materialColorCounts.slice();
            const mColors = materialColors.slice();
            w.postMessage(
              {
                type: 'set-styles' as const,
                styleIds: sIds,
                styleColors: sColors,
                voidKeys: vKeys,
                voidCounts: vCounts,
                voidValues: vValues,
                materialElementIds: mIds,
                materialColorCounts: mCounts,
                materialColors: mColors,
              },
              [
                sIds.buffer, sColors.buffer, vKeys.buffer, vCounts.buffer, vValues.buffer,
                mIds.buffer, mCounts.buffer, mColors.buffer,
              ],
            );
          } catch (err) {
            console.warn('[stream] set-styles dispatch failed:', err);
          }
        }

        stylesReceived = true;
        // Drain only when ALL gates are open (entity-index too). The
        // worker's tail-promise serialiser ensures any set-* runs
        // before any subsequent stream-chunk.
        drainQueuedChunksIfReady();
      } else if (evt.type === 'entity-index') {
        // Pre-pass exported its built entity_index. Forward to every
        // worker so they skip the ~5 s file re-scan in Rust's lazy
        // build path. SAB sharing for zero-copy distribution to N
        // workers — each gets a Uint32Array view over the same buffer.
        const ids = evt.ids as Uint32Array;
        const starts = evt.starts as Uint32Array;
        const lengths = evt.lengths as Uint32Array;
        console.log(`[stream] entity-index @ ${elapsed()}ms (${ids.length} entries)`);

        if (typeof SharedArrayBuffer !== 'undefined') {
          // Allocate one SAB triple, copy data once, share across all
          // workers without postMessage clone cost.
          const idsBytes = ids.byteLength;
          const startsBytes = starts.byteLength;
          const lengthsBytes = lengths.byteLength;
          const sabIds = new SharedArrayBuffer(idsBytes);
          const sabStarts = new SharedArrayBuffer(startsBytes);
          const sabLengths = new SharedArrayBuffer(lengthsBytes);
          new Uint32Array(sabIds).set(ids);
          new Uint32Array(sabStarts).set(starts);
          new Uint32Array(sabLengths).set(lengths);
          for (const w of workers) {
            try {
              w.postMessage({
                type: 'set-entity-index' as const,
                ids: new Uint32Array(sabIds),
                starts: new Uint32Array(sabStarts),
                lengths: new Uint32Array(sabLengths),
              });
            } catch (err) {
              console.warn('[stream] set-entity-index dispatch failed:', err);
            }
          }
          // Hand the same SAB triple to the parser worker (or any other
          // listener) so it can skip its own `scanEntitiesFastBytes` call.
          // Each consumer gets its own Uint32Array view over the shared
          // buffers — no extra copy.
          if (options?.onEntityIndex) {
            try {
              options.onEntityIndex(
                new Uint32Array(sabIds),
                new Uint32Array(sabStarts),
                new Uint32Array(sabLengths),
              );
            } catch (err) {
              console.warn('[stream] onEntityIndex callback failed:', err);
            }
          }
        } else {
          // SAB unavailable — clone per worker via structured clone.
          for (const w of workers) {
            try {
              w.postMessage({
                type: 'set-entity-index' as const,
                ids: ids.slice(),
                starts: starts.slice(),
                lengths: lengths.slice(),
              });
            } catch (err) {
              console.warn('[stream] set-entity-index dispatch failed:', err);
            }
          }
          if (options?.onEntityIndex) {
            try {
              options.onEntityIndex(ids.slice(), starts.slice(), lengths.slice());
            } catch (err) {
              console.warn('[stream] onEntityIndex callback failed:', err);
            }
          }
        }

        entityIndexReceived = true;
        drainQueuedChunksIfReady();
      } else if (evt.type === 'complete') {
        prepassJobsTotal = evt.totalJobs as number;
        console.log(`[stream] prepass complete @ ${elapsed()}ms totalJobs=${prepassJobsTotal} chunks=${chunkArrivals}`);
        // Unconditionally drive the prepass-complete handler here.
        // The outer loop's `prepassJobsTotal > 0` gate would skip
        // zero-geometry files (no IFC geometry entities), causing
        // the generator to wait forever. Calling here ensures
        // prepassDone flips even when totalJobs === 0.
        if (!prepassCompleteSeen) {
          prepassCompleteSeen = true;
          onPrepassComplete();
        }
      }
      return;
    }
    if (data.type === 'error') {
      // The streaming pre-pass is the first thing to touch the engine binary,
      // so a stale-deploy 404 of the wasm (#1363) lands here — let the host
      // reload onto the current deployment.
      notifyIfWasmAssetUnavailable(data.message);
      prepassError = new Error(data.message);
      prepassDone = true;
      prepassWorker.terminate();
      wake();
      return;
    }
    // The streaming variant doesn't emit `prepass-result` — the streaming
    // worker exits naturally after the JS callback returns from
    // `buildPrePassStreaming`. We treat unknown messages as no-ops.
  };
  prepassWorker.onerror = (e) => {
    notifyIfWasmAssetUnavailable(e.message);
    prepassError = new Error(`Pre-pass worker failed: ${e.message}`);
    prepassDone = true;
    prepassWorker.terminate();
    wake();
  };

  // Track when the pre-pass worker finishes by listening for either a
  // synthesized "complete" event from the Rust side OR a worker exit. The
  // Rust side currently doesn't post anything after `complete` (it returns
  // from JS), so we close the worker via terminate-on-complete in the host.
  // After we see the Rust `complete` event we can sendStreamEnd.
  const onPrepassComplete = () => {
    prepassDone = true;
    // Only signal stream-end to workers if they actually got
    // stream-start (which gates on `meta`). Zero-geometry files
    // never trigger meta → workers never start → no stream-end
    // needed. The dedicated zero-jobs branch in the outer loop
    // handles their teardown.
    if (streamStartSentToWorkers) {
      sendStreamEnd();
    }
    prepassWorker.terminate();
    wake();
  };

  // Dispatch the streaming pre-pass.
  // chunk_size = 50K is a deliberate compromise:
  //   • small enough that the FIRST chunk (always a tiny one — bounded by
  //     RTC_SAMPLE_THRESHOLD ≈ 50 jobs from the Rust side) reaches workers
  //     within ~1.5 s for fast TTFG;
  //   • large enough that subsequent chunks make few Rust→JS callbacks
  //     and few worker postMessages — each call into processGeometryBatch
  //     has fixed setup cost that compounds badly when invoked 30+ times.
  // Per-chunk fan-out (see `dispatchJobsChunkInternal`) splits each chunk
  // evenly across all workers so parallelism is preserved at every chunk.
  const visibilityFilter = options?.visibilityFilter ?? readVisibilityFilterOverride();
  if (visibilityFilter?.disabledTypes?.length || visibilityFilter?.skipTypeGeometry) {
    console.log(`[stream] load-time visibility filter: disabledTypes=[${visibilityFilter.disabledTypes?.join(',') ?? ''}] skipTypeGeometry=${visibilityFilter.skipTypeGeometry === true}`);
  }
  prepassWorker.postMessage({
    type: 'prepass-streaming',
    sharedBuffer,
    chunkSize: 50_000,
    ...(visibilityFilter?.disabledTypes ? { disabledTypes: visibilityFilter.disabledTypes } : {}),
    ...(visibilityFilter?.skipTypeGeometry ? { skipTypeGeometry: true } : {}),
  });

  // Drain the event queue until the pre-pass and all process workers complete.
  // The pre-pass `complete` event is captured inside the message handler
  // (we set prepassJobsTotal there) but the worker stays alive briefly
  // while the JS callback returns. Detect end-of-stream by:
  //   a) `prepassJobsTotal > 0` (or zero-jobs file): pre-pass emitted complete
  //   b) all workers reported `complete`
  let prepassCompleteSeen = false;

  while (true) {
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    }
    if (workerError) {
      for (const w of workers) {
        try { w.terminate(); } catch { /* cleanup — safe to ignore */ }
      }
      try { prepassWorker.terminate(); } catch { /* cleanup — safe to ignore */ }
      throw workerError;
    }
    if (prepassError) {
      for (const w of workers) {
        try { w.terminate(); } catch { /* cleanup — safe to ignore */ }
      }
      throw prepassError;
    }

    // Edge case: pre-pass for a file with zero geometry. The Rust side
    // emits `complete { totalJobs: 0 }`; meta never fired so workers
    // never received stream-start. Tear them down explicitly and yield
    // `complete`. Workers were pre-spawned with `init` so they need an
    // explicit terminate to exit.
    if (prepassDone && !streamStartSentToWorkers && prepassJobsTotal === 0) {
      for (const w of workers) {
        try { w.terminate(); } catch { /* cleanup — safe to ignore */ }
      }
      const coordinateInfo = coordinator.getFinalCoordinateInfo();
      yield { type: 'complete', totalMeshes: 0, coordinateInfo };
      return;
    }

    if (
      prepassDone
      && streamStartSentToWorkers
      && workersCompleted >= workers.length
      && eventQueue.length === 0
    ) {
      break;
    }

    await new Promise<void>((resolve) => { resolveWaiting = resolve; });
  }

  const coordinateInfo = coordinator.getFinalCoordinateInfo();
  // One aggregate per-load summary (only this scope holds the cross-worker
  // total). Counts include batch-summed upper bounds; see the event-type doc.
  // `diagnostics` is only reassigned inside the message-handler closure; restore
  // its declared union type at this yield via a cast (a bare reference compiled to
  // an unhelpful narrowed type under the generator's control-flow analysis).
  const loadDiagnostics = diagnostics as GeometryDiagnostics | null;
  if (loadDiagnostics && loadDiagnostics.totalCsgFailures > 0) {
    console.warn(
      `[ifc-lite] ${loadDiagnostics.totalCsgFailures} CSG failure(s) across ` +
        `${loadDiagnostics.productsWithFailures} product(s) this load - some ` +
        `openings/voids may be left uncut`,
    );
  }
  yield {
    type: 'complete',
    totalMeshes,
    coordinateInfo,
    ...(loadDiagnostics ? { diagnostics: loadDiagnostics } : {}),
  };
  } finally {
    for (const w of workers) {
      try { w.terminate(); } catch { /* cleanup — safe to ignore */ }
    }
    try { prepassWorker.terminate(); } catch { /* cleanup — safe to ignore */ }
  }
}
