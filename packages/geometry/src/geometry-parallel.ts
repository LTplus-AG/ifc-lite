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
import { notifyIfWasmAssetUnavailable, notifyIfWorkerScriptUnavailable } from './wasm-asset-error.js';

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

/**
 * SPIKE flag: shard the entity-index scan across the idle geometry workers and
 * deliver the stitched index early, instead of waiting for the pre-pass
 * worker's single-threaded post-scan `entity-index` emission. Read off
 * `globalThis.__IFC_LITE_SHARD_SCAN` (benchmark A/B knob). Truthy ⇒ on.
 */
function readShardScanFlag(): boolean {
  const g = globalThis as unknown as { __IFC_LITE_SHARD_SCAN?: unknown };
  const v = g.__IFC_LITE_SHARD_SCAN;
  // ON by default; 0/'0'/false is the kill switch (same convention as the
  // other #1682 load/render knobs).
  if (v === 0 || v === '0' || v === false) return false;
  return true;
}

/** One shard's returned columns + handoff (see `scanEntityIndexShard`). */
interface ShardColumns {
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
  /** Per-record prepass class (PREPASS_CLASS_*; 4 = IfcStyledItem). */
  classes: Uint8Array;
  /** Global start of the next shard's first real entity, or -1 at EOF. */
  handoff: number;
}

/**
 * SPIKE: stitch N speculative shard scans into the full entity index —
 * byte-identical to the single-threaded scan. Port of the native
 * `parallel_scan::stitch`: shard 0 is authoritative (header-aware start); for
 * shard i>0 the previous shard's validated `handoff` is a real entity start, so
 * binary-search shard i's `starts` for it and drop the speculative prefix before
 * it. Concatenates the validated slices in shard order (= file order), so
 * last-wins on a duplicate id is preserved when the worker rebuilds its map.
 *
 * Returns null on the rare "handoff not found" case (speculative overshoot / a
 * record spanning a whole shard), which needs the serial-rescan fallback the JS
 * spike doesn't implement — the caller falls back to the pre-pass's own index.
 */
function stitchShards(shards: ShardColumns[]): { ids: Uint32Array; starts: Uint32Array; lengths: Uint32Array; classes: Uint8Array } | null {
  const n = shards.length;

  // Phase 1 — locate each shard's validated slice (binary-search the previous
  // shard's handoff) WITHOUT copying, so the output size is exact before any
  // allocation. Exactness matters: the id/start/length columns are allocated
  // SAB-backed below and handed to every worker as full-buffer views, so a
  // cap-sized buffer would let consumers read past the last real record.
  const sliceFrom = new Array<number>(n).fill(0);
  let used = 1;
  let w = shards[0].ids.length; // shard 0 is authoritative, take every record
  let expectedStart = shards[0].handoff; // -1 => no more real entities
  for (let i = 1; i < n; i++) {
    if (expectedStart < 0) break;
    // starts is strictly increasing → binary-search for expectedStart.
    const starts = shards[i].starts;
    let lo = 0;
    let hi = starts.length - 1;
    let p = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = starts[mid];
      if (v === expectedStart) { p = mid; break; }
      if (v < expectedStart) lo = mid + 1;
      else hi = mid - 1;
    }
    if (p < 0) {
      // Handoff not present in this shard — fallback path (not implemented here).
      return null;
    }
    sliceFrom[i] = p;
    w += starts.length - p;
    expectedStart = shards[i].handoff;
    used = i + 1;
  }

  // Phase 2 — single concatenation copy, straight into SharedArrayBuffer-backed
  // columns. The stitched index used to be copied THREE times per column on the
  // main thread (cap-array stitch → `.slice()` to contiguous → `.set()` into
  // fresh SABs in deliverEntityIndex); writing the stitch output into SABs
  // directly makes index delivery zero-copy (~450 MB of critical-path memcpy
  // saved on a 19M-entity file). `classes` stays plain: its only consumer past
  // the span-extraction loop is the pre-pass worker, which takes it by transfer.
  const sabAvailable = typeof SharedArrayBuffer !== 'undefined';
  const u32Column = (len: number) =>
    new Uint32Array(sabAvailable ? new SharedArrayBuffer(len * 4) : new ArrayBuffer(len * 4));
  const outIds = u32Column(w);
  const outStarts = u32Column(w);
  const outLengths = u32Column(w);
  const outClasses = new Uint8Array(w);
  let o = 0;
  for (let i = 0; i < used; i++) {
    const s = shards[i];
    const p = sliceFrom[i];
    outIds.set(p === 0 ? s.ids : s.ids.subarray(p), o);
    outStarts.set(p === 0 ? s.starts : s.starts.subarray(p), o);
    outLengths.set(p === 0 ? s.lengths : s.lengths.subarray(p), o);
    outClasses.set(p === 0 ? s.classes : s.classes.subarray(p), o);
    o += s.ids.length - p;
  }

  return { ids: outIds, starts: outStarts, lengths: outLengths, classes: outClasses };
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
  // Sharded pre-pass: prepass `complete` arrived while chunks were still
  // queued behind the async styles event; stream-end fires on drain instead.
  let streamEndPendingQueueDrain = false;
  let stylesReceived = false;
  let entityIndexReceived = false;

  // ── SPIKE: sharded entity-index scan across the idle geometry workers ──
  // When on, split the file into N byte ranges, have each idle worker scan its
  // shard (`scanEntityIndexShard`), stitch the columns on THIS thread, and
  // deliver the entity index early (instead of waiting for the pre-pass
  // worker's single-threaded post-scan `entity-index` event). Measures the
  // parser-tail-contention blocker from prior art dd56ea9e.
  const shardScanEnabled = readShardScanFlag();
  let entityIndexDeliveredEarly = false;
  const shardResults: (ShardColumns | null)[] = [];
  let shardResultsRemaining = 0;
  let shardScanDispatchedAt = -1;
  // Shard-resolved styled-item slices (see onAllStyleSlicesReceived).
  interface StylesSlice {
    orphanIds: Uint32Array; orphanColors: Float32Array;
    geomIds: Uint32Array; geomColors: Float32Array; error?: string;
  }
  const stylesSliceResults: (StylesSlice | null)[] = [];
  let stylesSlicesRemaining = 0;
  // Support spans extracted from the shard classes (sharded mode only).
  let supportSpans: {
    colourMapSpans: Uint32Array; materialDefSpans: Uint32Array;
    relMaterialSpans: Uint32Array; voidSpans: Uint32Array;
    fillsSpans: Uint32Array; aggregateSpans: Uint32Array;
  } | null = null;
  // Deferred finalize: needs BOTH the merged style slices and the meta event's
  // planeAngleToRadians (finalize seeds its decoder with it, exactly like the
  // serial styles block).
  let mergedStylesForFinalize: {
    orphanIds: Uint32Array; orphanColors: Float32Array;
    geomIds: Uint32Array; geomColors: Float32Array;
  } | null = null;
  let finalizeDispatched = false;
  // Forward ref: assigned at the pre-pass dispatch site (which executes during
  // synchronous setup, long before any shard result can arrive).
  let startPrepass: (
    sharded: boolean,
    indexColumns?: { ids: Uint32Array; starts: Uint32Array; lengths: Uint32Array; classes: Uint8Array },
  ) => void = () => {};

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
    // True once the worker delivers ANY message — distinguishes an in-worker
    // crash from the worker SCRIPT failing to load (stale-deploy 404, #1251).
    let workerSpoke = false;
    worker.onmessage = (e: MessageEvent) => {
      workerSpoke = true;
      const msg = e.data;
      if (msg.type === 'ready') {
        console.log(`[stream] worker[${workerIndex}] WASM ready @ ${elapsed()}ms`);
        return;
      }
      if (msg.type === 'shard-result') {
        // SPIKE: one worker's entity-index shard. Store it; when all shards are
        // in, stitch on this thread and deliver the index early.
        const si = msg.shardIndex as number;
        shardResults[si] = {
          ids: msg.ids as Uint32Array,
          starts: msg.starts as Uint32Array,
          lengths: msg.lengths as Uint32Array,
          classes: msg.classes as Uint8Array,
          handoff: msg.handoff as number,
        };
        shardResultsRemaining--;
        console.log(`[stream][shard] worker[${workerIndex}] shard ${si} done @ ${elapsed()}ms (${(msg.ids as Uint32Array).length} entities, remaining=${shardResultsRemaining})`);
        if (shardResultsRemaining === 0) {
          onAllShardsReceived();
        }
        return;
      }
      if (msg.type === 'styles-final') {
        // Finalized styles payload from worker 0 — feed it through the SAME
        // prepass styles-event path (gates, logging, distribution) by
        // synthesizing a prepass-stream message. The handler is a plain
        // closure; invoking it directly is safe (no `this`).
        (prepassWorker.onmessage as (e: MessageEvent) => void)({
          data: { type: 'prepass-stream', event: { type: 'styles', ...(msg.payload as Record<string, unknown>) } },
        } as MessageEvent);
        return;
      }
      if (msg.type === 'styles-shard-result') {
        const si = msg.sliceIndex as number;
        stylesSliceResults[si] = {
          orphanIds: msg.orphanIds as Uint32Array,
          orphanColors: msg.orphanColors as Float32Array,
          geomIds: msg.geomIds as Uint32Array,
          geomColors: msg.geomColors as Float32Array,
          error: msg.error as string | undefined,
        };
        stylesSlicesRemaining--;
        console.log(`[stream][shard] worker[${workerIndex}] style slice ${si} done @ ${elapsed()}ms (${(msg.geomIds as Uint32Array).length} geometry styles, remaining=${stylesSlicesRemaining})`);
        if (stylesSlicesRemaining === 0) {
          onAllStyleSlicesReceived();
        }
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
        // The worker already emits `MeshData`-shaped objects (see the worker's
        // `meshData` construction: typed arrays ride the transfer list, optional
        // fields are conditionally spread there). Structured clone preserves
        // typed-array types, so re-mapping every mesh here only re-allocated
        // ~one wrapper object per mesh (~110k per large load) on the main
        // thread. Pass the transferred objects straight through.
        const meshes: MeshData[] = msg.meshes as MeshData[];
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
        (workerSpoke
          ? 'worker terminated unexpectedly'
          : 'worker script failed to load (possibly a stale deployment)');
      // Covers both the wasm-binary 404 (message present, #1363) and the
      // worker SCRIPT 404 after a redeploy (empty message, never spoke).
      notifyIfWorkerScriptUnavailable(err, workerSpoke);
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
      //
      // NB: the `prepass-columns` event (referenced-repmaps / instantiated-
      // type-ids / material-layer index, #957/#563) is deliberately NOT gated
      // here: the pre-pass emits it BEFORE the first jobs chunk and workers
      // apply messages FIFO, so it always lands before any batch. An older
      // engine binary that never emits it simply falls back to the worker's
      // byte-identical lazy rebuild — gating would turn that into a hang.
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
    // Sharded pre-pass: the prepass can COMPLETE while chunks are still queued
    // behind the (asynchronously finalized) styles event. stream-end was
    // deferred in onPrepassComplete for that case — release it now that the
    // queue is empty, or workers would never see these jobs (measured: a run
    // completed with ZERO meshes).
    if (streamEndPendingQueueDrain) {
      streamEndPendingQueueDrain = false;
      sendStreamEnd();
    }
  };

  // Step-by-step timing so we can tell exactly where time goes.
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const overrideNote = options?.workerCountOverride != null
    ? ` (override=${options.workerCountOverride}, bound=${workerCountResult.reason})`
    : ` (cores=${cores}, bound=${workerCountResult.reason})`;
  console.log(`[stream] processParallel start, fileSizeMB=${fileSizeMB.toFixed(1)} workerCount=${workerCount}${overrideNote}`);

  /**
   * Deliver a built entity index to every geometry worker (via a shared SAB
   * triple) + the parser worker (`onEntityIndex`), then open the entity-index
   * gate and drain. Shared by the pre-pass path and the SPIKE sharded-early
   * path so both distribute the index identically.
   */
  const deliverEntityIndex = (
    ids: Uint32Array,
    starts: Uint32Array,
    lengths: Uint32Array,
    source: 'prepass' | 'sharded',
  ) => {
    console.log(`[stream] entity-index (${source}) @ ${elapsed()}ms (${ids.length} entries)`);
    if (typeof SharedArrayBuffer !== 'undefined') {
      // Sharded-stitch columns arrive already SAB-backed (stitchShards writes
      // its exact-size output into SABs) — share them as-is. The serial
      // pre-pass path still hands over plain transferred buffers, which need
      // the one copy into SABs to be shareable with every worker.
      let sabIds: SharedArrayBuffer;
      let sabStarts: SharedArrayBuffer;
      let sabLengths: SharedArrayBuffer;
      if (
        ids.buffer instanceof SharedArrayBuffer &&
        starts.buffer instanceof SharedArrayBuffer &&
        lengths.buffer instanceof SharedArrayBuffer
      ) {
        sabIds = ids.buffer;
        sabStarts = starts.buffer;
        sabLengths = lengths.buffer;
      } else {
        sabIds = new SharedArrayBuffer(ids.byteLength);
        sabStarts = new SharedArrayBuffer(starts.byteLength);
        sabLengths = new SharedArrayBuffer(lengths.byteLength);
        new Uint32Array(sabIds).set(ids);
        new Uint32Array(sabStarts).set(starts);
        new Uint32Array(sabLengths).set(lengths);
      }
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
      for (const w of workers) {
        try {
          w.postMessage({
            type: 'set-entity-index' as const,
            ids: ids.slice(), starts: starts.slice(), lengths: lengths.slice(),
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
  };

  /**
   * All shards are in — stitch, deliver the index early, fan the styled-item
   * slices out for parallel style resolution, and start the SHARDED pre-pass
   * (its start was deferred; it receives the stitched index so it skips its
   * own index build, resolves meta against the full index, and leaves styles
   * to the shards). On a stitch miss (rare handoff-not-found), fall back to
   * the serial pre-pass path — identical to flag-off behaviour.
   */
  const onAllShardsReceived = () => {
    const shards = shardResults as ShardColumns[];
    const stitched = stitchShards(shards);
    if (!stitched) {
      console.warn('[stream][shard] stitch fallback triggered (handoff not found) — serial pre-pass');
      startPrepass(false);
      return;
    }
    console.log(`[stream][shard] stitched ${stitched.ids.length} entities @ ${elapsed()}ms (shard scan started @ ${shardScanDispatchedAt}ms)`);
    // Exact-size SAB-backed columns straight from the stitch — no contiguity
    // copy needed, and deliverEntityIndex shares them zero-copy.
    const ids = stitched.ids;
    const starts = stitched.starts;
    const lengths = stitched.lengths;
    entityIndexDeliveredEarly = true;
    // set-entity-index reaches every worker FIRST (FIFO), so the style-shard
    // messages below always find the index installed.
    deliverEntityIndex(ids, starts, lengths, 'sharded');

    // Extract the styled-item span triples (class 4) in FILE ORDER from the
    // stitched columns, split into one contiguous slice per worker, and
    // resolve them in parallel while everyone waits on the pre-pass scan.
    const classes = stitched.classes;
    // Class codes (see Rust PREPASS_CLASS_*): 4 styled, 5 colour map,
    // 6 material def repr, 7 rel-associates-material, 8 voids, 9 fills,
    // 10 aggregates. Extract each list in FILE ORDER.
    const counts = new Uint32Array(11);
    for (let i = 0; i < classes.length; i++) counts[classes[i]]++;
    const kinds = [4, 5, 6, 7, 8, 9, 10] as const;
    const spanLists = new Map<number, { arr: Uint32Array; w: number }>();
    for (const k of kinds) spanLists.set(k, { arr: new Uint32Array(counts[k] * 3), w: 0 });
    for (let i = 0; i < classes.length; i++) {
      const slot = spanLists.get(classes[i]);
      if (!slot) continue;
      slot.arr[slot.w] = ids[i];
      slot.arr[slot.w + 1] = starts[i];
      slot.arr[slot.w + 2] = lengths[i];
      slot.w += 3;
    }
    supportSpans = {
      colourMapSpans: spanLists.get(5)!.arr,
      materialDefSpans: spanLists.get(6)!.arr,
      relMaterialSpans: spanLists.get(7)!.arr,
      voidSpans: spanLists.get(8)!.arr,
      fillsSpans: spanLists.get(9)!.arr,
      aggregateSpans: spanLists.get(10)!.arr,
    };
    const styledCount = counts[4];
    const styledSpans = spanLists.get(4)!.arr;
    // 2 slices per worker (round-robin): the tail is set by the SLOWEST
    // worker, and macOS occasionally schedules one onto a slow core — halving
    // the slice size halves the damage a slow core can do to the tail.
    // Slice order stays file order and the merge is by slice INDEX, so
    // first-wins precedence is unchanged.
    const sliceCount = workers.length * 2;
    console.log(`[stream][shard] ${styledCount} styled items -> ${sliceCount} style slices @ ${elapsed()}ms`);
    stylesSliceResults.length = sliceCount;
    stylesSlicesRemaining = sliceCount;
    for (let i = 0; i < sliceCount; i++) {
      const from = Math.floor((i * styledCount) / sliceCount) * 3;
      const to = i + 1 === sliceCount ? styledCount * 3 : Math.floor(((i + 1) * styledCount) / sliceCount) * 3;
      const slice = styledSpans.slice(from, to);
      workers[i % workers.length].postMessage(
        { type: 'resolve-styles-shard' as const, sharedBuffer, sliceIndex: i, spans: slice },
        [slice.buffer],
      );
    }

    // Start the sharded pre-pass with the stitched index columns + classes
    // (stage 2: the pre-pass discovers jobs/spans from the class column and
    // never byte-scans the file).
    // `classes` is exact-size (two-phase stitch) so it transfers as-is; the
    // span-extraction loop above already read everything main needs from it.
    startPrepass(true, { ids, starts, lengths, classes });
  };

  /**
   * Merge the shard-resolved style maps IN SLICE ORDER with first-wins per id
   * (reproducing the serial resolver's file-order precedence) and queue the
   * finalize call on the pre-pass worker. FIFO on that worker guarantees the
   * stash from the sharded pre-pass call is present when finalize runs; the
   * canonical flatten emits the styles event through the same channel.
   */
  const onAllStyleSlicesReceived = () => {
    const orphan = new Map<number, number>(); // id -> base float index (slice,i)
    const geom = new Map<number, number>();
    // First pass: count winners to size the merged columns.
    const orphanWin: Array<[number, Float32Array, number]> = [];
    const geomWin: Array<[number, Float32Array, number]> = [];
    for (const slice of stylesSliceResults) {
      if (!slice) continue;
      if (slice.error) console.warn(`[stream][shard] style slice failed (degraded colours possible): ${slice.error}`);
      for (let i = 0; i < slice.orphanIds.length; i++) {
        const id = slice.orphanIds[i];
        if (!orphan.has(id)) { orphan.set(id, 1); orphanWin.push([id, slice.orphanColors, i * 4]); }
      }
      for (let i = 0; i < slice.geomIds.length; i++) {
        const id = slice.geomIds[i];
        if (!geom.has(id)) { geom.set(id, 1); geomWin.push([id, slice.geomColors, i * 4]); }
      }
    }
    const orphanIds = new Uint32Array(orphanWin.length);
    const orphanColors = new Float32Array(orphanWin.length * 4);
    orphanWin.forEach(([id, colors, o], i) => {
      orphanIds[i] = id;
      orphanColors.set(colors.subarray(o, o + 4), i * 4);
    });
    const geomIds = new Uint32Array(geomWin.length);
    const geomColors = new Float32Array(geomWin.length * 4);
    geomWin.forEach(([id, colors, o], i) => {
      geomIds[i] = id;
      geomColors.set(colors.subarray(o, o + 4), i * 4);
    });
    console.log(`[stream][shard] styles merged: ${geomWin.length} geometry + ${orphanWin.length} orphan @ ${elapsed()}ms`);
    mergedStylesForFinalize = { orphanIds, orphanColors, geomIds, geomColors };
    maybeDispatchFinalize();
  };

  /**
   * Dispatch the styles finalize to geometry worker 0 once BOTH the merged
   * style slices and the meta event (for planeAngleToRadians) are in. Worker 0
   * already holds the entity index (set-entity-index preceded the style
   * slices, FIFO), and is idle until the first jobs drain — which itself
   * waits on the styles event this call produces.
   */
  const maybeDispatchFinalize = () => {
    if (finalizeDispatched || !mergedStylesForFinalize || !supportSpans || !prepassMeta) return;
    finalizeDispatched = true;
    const m = mergedStylesForFinalize;
    workers[0].postMessage(
      {
        type: 'finalize-styles' as const,
        sharedBuffer,
        orphanIds: m.orphanIds,
        orphanColors: m.orphanColors,
        geomIds: m.geomIds,
        geomColors: m.geomColors,
        ...supportSpans,
        planeAngleToRadians: prepassMeta.planeAngleToRadians ?? 1,
      },
      [m.orphanIds.buffer, m.orphanColors.buffer, m.geomIds.buffer, m.geomColors.buffer],
    );
    console.log(`[stream][shard] styles finalize dispatched to worker[0] @ ${elapsed()}ms`);
  };

  // SPIKE: kick off the shard scans on the idle workers NOW (before the pre-pass
  // worker's single scan). Gated: flag on, SAB available, file big enough, ≥2
  // workers. The workers' tail-promise serialiser runs these after their `init`.
  const SHARD_MIN_BYTES = 8 * 1024 * 1024;
  const shardActive = shardScanEnabled
    && typeof SharedArrayBuffer !== 'undefined'
    && sharedBuffer.byteLength >= SHARD_MIN_BYTES
    && workers.length >= 2;
  if (shardActive) {
    const len = sharedBuffer.byteLength;
    const n = workers.length;
    shardResults.length = n;
    shardResultsRemaining = n;
    shardScanDispatchedAt = elapsed();
    console.log(`[stream][shard] dispatching ${n} shard scans over ${(len / (1024 * 1024)).toFixed(1)}MB @ ${shardScanDispatchedAt}ms`);
    for (let i = 0; i < n; i++) {
      const rangeStart = Math.floor((i * len) / n);
      const rangeEnd = i + 1 === n ? len : Math.floor(((i + 1) * len) / n);
      workers[i].postMessage({
        type: 'scan-shard' as const,
        sharedBuffer,
        shardIndex: i,
        rangeStart,
        rangeEnd,
      });
    }
  }

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
  // True once the pre-pass worker delivers ANY message — distinguishes an
  // in-worker failure from the worker SCRIPT failing to load (a stale-deploy
  // 404 is served as text/plain; the browser blocks the worker and fires
  // onerror with an EMPTY message, so the wasm matcher alone never fires).
  let prepassSpoke = false;
  prepassWorker.onmessage = (e: MessageEvent) => {
    prepassSpoke = true;
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
        maybeDispatchFinalize();
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
        // Pre-pass exported its built entity_index. In the SPIKE sharded path
        // the stitched index was already delivered early — here we only run the
        // byte-identical assertion against the pre-pass's single-scan columns
        // (the hard correctness gate) and skip the redundant re-delivery.
        // Otherwise (baseline), deliver it to workers + the parser worker so
        // they skip the ~5 s Rust file re-scan.
        const ids = evt.ids as Uint32Array;
        const starts = evt.starts as Uint32Array;
        const lengths = evt.lengths as Uint32Array;
        if (entityIndexDeliveredEarly) {
          // Sharded mode never reaches here (the sharded pre-pass skips the
          // entity-index event); guard against double delivery regardless.
          console.log(`[stream] pre-pass entity-index arrived @ ${elapsed()}ms (already delivered via shards; ignoring)`);
        } else {
          deliverEntityIndex(ids, starts, lengths, 'prepass');
        }
      } else if (evt.type === 'prepass-columns') {
        // Pre-pass computed the referenced-repmaps + instantiated-type-id sets
        // and the material-layer index ONCE (issue #957 / #563). Forward to
        // every worker so its first batch skips the per-worker full-file
        // rebuild. Small (id sets + one record per material-associated element),
        // so a per-worker structured-clone slice is cheap; each slice goes in
        // its own transfer list. Must reach workers AFTER set-entity-index
        // (whose setter clears these caches) — the pre-pass emits this event
        // after `entity-index` and workers handle messages FIFO, so it holds.
        const referencedRepmaps = evt.referencedRepmaps as Uint32Array;
        const instantiatedTypeIds = evt.instantiatedTypeIds as Uint32Array;
        // #1623 Phase 3 don't-bake plan (RepresentationMap ids repeated >= 2x).
        // Absent on older pre-pass builds -> empty, so the batch never arms.
        const mappedInstancePlan = (evt.mappedInstancePlan as Uint32Array | undefined) ?? new Uint32Array(0);
        const mliElementIds = evt.mliElementIds as Uint32Array;
        const mliAxis = evt.mliAxis as Uint32Array;
        const mliLayerCounts = evt.mliLayerCounts as Uint32Array;
        const mliDirectionSense = evt.mliDirectionSense as Float64Array;
        const mliOffset = evt.mliOffset as Float64Array;
        const mliLayerMaterialIds = evt.mliLayerMaterialIds as Uint32Array;
        const mliLayerThicknesses = evt.mliLayerThicknesses as Float64Array;
        console.log(`[stream] prepass-columns @ ${elapsed()}ms (${referencedRepmaps.length} repmaps, ${instantiatedTypeIds.length} inst-types, ${mliElementIds.length} layer-elems)`);

        for (const w of workers) {
          try {
            const rRepmaps = referencedRepmaps.slice();
            const rTypeIds = instantiatedTypeIds.slice();
            const rMappedPlan = mappedInstancePlan.slice();
            const mIds = mliElementIds.slice();
            const mAxis = mliAxis.slice();
            const mCounts = mliLayerCounts.slice();
            const mDir = mliDirectionSense.slice();
            const mOff = mliOffset.slice();
            const mMatIds = mliLayerMaterialIds.slice();
            const mThick = mliLayerThicknesses.slice();
            w.postMessage(
              {
                type: 'set-prepass-columns' as const,
                referencedRepmaps: rRepmaps,
                instantiatedTypeIds: rTypeIds,
                mappedInstancePlan: rMappedPlan,
                mliElementIds: mIds,
                mliAxis: mAxis,
                mliLayerCounts: mCounts,
                mliDirectionSense: mDir,
                mliOffset: mOff,
                mliLayerMaterialIds: mMatIds,
                mliLayerThicknesses: mThick,
              },
              [
                rRepmaps.buffer, rTypeIds.buffer, rMappedPlan.buffer, mIds.buffer, mAxis.buffer, mCounts.buffer,
                mDir.buffer, mOff.buffer, mMatIds.buffer, mThick.buffer,
              ],
            );
          } catch (err) {
            console.warn('[stream] set-prepass-columns dispatch failed:', err);
          }
        }

        // Not a dispatch gate (see dispatchJobsChunk); the pre-pass emits this
        // before the first jobs chunk, so drain here only for symmetry with the
        // other post-scan events in case chunks were queued behind styles/index.
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
    const detail =
      (e?.message && String(e.message)) ||
      (prepassSpoke
        ? 'worker terminated unexpectedly'
        : 'worker script failed to load (possibly a stale deployment)');
    // Covers both the wasm-binary 404 (message present, #1363) and the worker
    // SCRIPT 404 after a redeploy (empty message, never spoke) — either way
    // the host reloads once onto the current deployment.
    notifyIfWorkerScriptUnavailable(e, prepassSpoke);
    prepassError = new Error(`Pre-pass worker failed: ${detail}`);
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
      if (queuedChunks.length > 0 || (shardActive && !stylesReceived)) {
        // Sharded mode: chunks are (or will be) queued behind the async
        // styles finalize — ending the workers now would drop those jobs.
        streamEndPendingQueueDrain = true;
      } else {
        sendStreamEnd();
      }
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
  startPrepass = (
    sharded: boolean,
    indexColumns?: { ids: Uint32Array; starts: Uint32Array; lengths: Uint32Array; classes: Uint8Array },
  ) => {
    if (sharded && indexColumns) {
      // The id/start/length columns are SharedArrayBuffer-backed (two-phase
      // stitch): they CANNOT go on the transfer list (transferring a SAB
      // throws) and don't need to — postMessage shares the SAB for free.
      // `classes` is a plain exact-size buffer and is the pre-pass worker's
      // alone from here, so it still transfers (a structured clone would
      // double its transient memory).
      const transfers: ArrayBuffer[] = [];
      for (const column of [
        indexColumns.ids.buffer,
        indexColumns.starts.buffer,
        indexColumns.lengths.buffer,
        indexColumns.classes.buffer,
      ]) {
        if (typeof SharedArrayBuffer === 'undefined' || !(column instanceof SharedArrayBuffer)) {
          transfers.push(column as ArrayBuffer);
        }
      }
      prepassWorker.postMessage({
        type: 'prepass-streaming-sharded',
        sharedBuffer,
        chunkSize: 50_000,
        ...(visibilityFilter?.disabledTypes ? { disabledTypes: visibilityFilter.disabledTypes } : {}),
        ...(visibilityFilter?.skipTypeGeometry ? { skipTypeGeometry: true } : {}),
        indexIds: indexColumns.ids,
        indexStarts: indexColumns.starts,
        indexLengths: indexColumns.lengths,
        indexClasses: indexColumns.classes,
      }, transfers);
    } else {
      prepassWorker.postMessage({
        type: 'prepass-streaming',
        sharedBuffer,
        chunkSize: 50_000,
        ...(visibilityFilter?.disabledTypes ? { disabledTypes: visibilityFilter.disabledTypes } : {}),
        ...(visibilityFilter?.skipTypeGeometry ? { skipTypeGeometry: true } : {}),
      });
    }
  };
  // Sharded mode DEFERS the pre-pass start until the stitched index is ready
  // (onAllShardsReceived) — racing the serial scan against N shard scans of
  // the same bytes just contends for memory bandwidth and slows BOTH (measured
  // +2.7s on meta for an 883MB model).
  if (!shardActive) {
    startPrepass(false);
  }

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
