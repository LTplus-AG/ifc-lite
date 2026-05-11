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
import type { MeshData } from './types.js';
import type { StreamingGeometryEvent } from './index.js';
import { pickWorkerCount } from './worker-count.js';

interface PrepassMeta {
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
   * Phase 2 of single-controller-rayon-design.md — when true, spawn ONE
   * controller worker that runs `processGeometryBatchParallel` with
   * an internal rayon thread pool, instead of the N-independent-worker
   * pool. The host can opt in via `localStorage.getItem('ifc-lite:single-controller')`
   * (set in `useIfcLoader.ts`). Same input/output contract; the
   * controller mirrors `geometry.worker.ts`'s message protocol so this
   * file's dispatch loop is unchanged.
   *
   * Trade-offs documented in the design doc:
   *   - peakWasm should drop ~5.3 GB → ~3 GB (one heap, not three).
   *   - Stream tail should drop on rayon-friendly hosts (10+ cores).
   *   - Falls back silently to N-worker path if the threaded WASM
   *     bundle fails to load (no COI, Safari, etc.).
   */
  useSingleController?: boolean;
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

  // Phase 2 controller path: ONE worker that does internal rayon
  // parallelism, instead of N independent WASM-instance workers. The
  // controller imports the threaded bundle (`@ifc-lite/wasm-threaded`)
  // and calls processGeometryBatchParallel for each stream-chunk.
  //
  // The PRE-PASS worker always stays on the legacy bundle —
  // `geometry.worker.ts` handles `prepass-streaming` messages; the
  // controller does not. The legacy bundle is also slimmer (no
  // wasm-bindgen-rayon snippets) so the pre-pass pays no atomics tax.
  const useController = options?.useSingleController === true;
  const makeGeometryWorker = () => useController
    ? new Worker(
        new URL('./geometry-controller.worker.ts', import.meta.url),
        { type: 'module' },
      )
    : new Worker(
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
  const queuedChunks: Uint32Array[] = [];
  let stylesReceived = false;
  let entityIndexReceived = false;

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
        }) => ({
          expressId: m.expressId,
          ifcType: m.ifcType,
          positions: m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions),
          normals: m.normals instanceof Float32Array ? m.normals : new Float32Array(m.normals),
          indices: m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices),
          color: m.color,
        }));
        if (meshes.length > 0) {
          // Update totalMeshes per batch so consumers see a live
          // running count via `totalSoFar`. The `complete` event
          // below used to be the only updater, leaving streamed
          // batches reporting a stale total until the worker exited.
          totalMeshes += meshes.length;
          coordinator.processMeshesIncremental(meshes);
          const coordinateInfo = coordinator.getCurrentCoordinateInfo();
          eventQueue.push({
            type: 'batch',
            meshes,
            totalSoFar: totalMeshes,
            coordinateInfo: coordinateInfo || undefined,
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
        workersCompleted++;
        worker.terminate();
        wake();
        return;
      }
      if (msg.type === 'error') {
        workerError = new Error(`Geometry worker error: ${msg.message}`);
        workersCompleted++;
        worker.terminate();
        wake();
        return;
      }
    };
    worker.onerror = (err) => {
      workerError = new Error(`Geometry worker failed: ${err.message}`);
      workersCompleted++;
      worker.terminate();
      wake();
    };
  };

  // Pick worker count and pre-spawn them now. `pickWorkerCount` needs a
  // totalJobs estimate; use file-size proxy. The memory-budget cap in
  // `pickWorkerCount` keeps an over-estimate harmless.
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  const deviceMemoryGB = typeof navigator !== 'undefined'
    ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) : 8;
  const fileSizeMB = buffer.byteLength / (1024 * 1024);
  const estimatedJobs = Math.max(1, Math.ceil(fileSizeMB * 100));
  // Controller path: ONE worker. The worker spins up (cores - 1) rayon
  // helpers internally; pickWorkerCount's per-worker budget no longer
  // applies because we hold ONE WASM heap, not N. N-worker path
  // unchanged.
  const workerCount = useController
    ? 1
    : pickWorkerCount({ fileSizeMB, cores, deviceMemoryGB, totalJobs: estimatedJobs });

  const workers: Worker[] = [];
  for (let i = 0; i < workerCount; i++) {
    const worker = makeGeometryWorker();
    workers.push(worker);
    installWorkerHandlers(worker, i);
    // Kick off WASM compile concurrently with the pre-pass scan. The
    // worker's tail-promise serialiser guarantees this `init` completes
    // before any subsequent `stream-start`/`stream-chunk` runs.
    worker.postMessage({ type: 'init' });
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

    eventQueue.push({
      type: 'rtcOffset',
      rtcOffset: { x: rtcX, y: rtcY, z: rtcZ },
      hasRtc: effectiveNeedsShift,
    });
    wake();

    const emptyU32 = new Uint32Array(0);
    const emptyU8 = new Uint8Array(0);
    for (const worker of workers) {
      worker.postMessage({
        type: 'stream-start' as const,
        sharedBuffer,
        unitScale: prepassMeta.unitScale,
        rtcX, rtcY, rtcZ,
        needsShift: effectiveNeedsShift,
        voidKeys: emptyU32,
        voidCounts: emptyU32,
        voidValues: emptyU32,
        styleIds: emptyU32,
        styleColors: emptyU8,
      });
    }

    // Don't drain queued chunks here — wait for the `styles` event so
    // every chunk gets processed with resolved colours. The styles
    // handler does the drain after posting set-styles.
  };

  function dispatchJobsChunkInternal(jobs: Uint32Array): void {
    if (workers.length === 0 || jobs.length === 0) return;
    // Round-robin sending whole chunks to single workers leaves N-1
    // workers idle whenever the chunk count is small. Instead split each
    // Rust chunk evenly across all workers so every worker processes a
    // slice of every chunk in parallel — full pool utilisation from the
    // very first chunk.
    const totalSubJobs = Math.floor(jobs.length / 3);
    if (totalSubJobs === 0) return;
    const subPerWorker = Math.ceil(totalSubJobs / workers.length);
    try {
      for (let i = 0; i < workers.length; i++) {
        const start = i * subPerWorker * 3;
        const end = Math.min(start + subPerWorker * 3, jobs.length);
        if (start >= end) continue;
        // `slice` allocates a new ArrayBuffer per piece so each can be in
        // its own transfer list. Cheap relative to the WASM work that follows.
        const sub = jobs.slice(start, end);
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

  const dispatchJobsChunk = (jobs: Uint32Array) => {
    if (!streamStartSentToWorkers || !stylesReceived || !entityIndexReceived) {
      // Hold until stream-start AND styles AND entity-index have all
      // been posted to workers. Without styles the meshes would render
      // with default per-type colours; without the pre-built entity
      // index, the worker's first WASM call would re-scan the file
      // (~5 s on 1 GB) to rebuild the index inside Rust.
      queuedChunks.push(jobs);
      return;
    }
    dispatchJobsChunkInternal(jobs);
  };

  /** Drain queued chunks once all gating conditions are met. */
  const drainQueuedChunksIfReady = () => {
    if (!streamStartSentToWorkers || !stylesReceived || !entityIndexReceived) return;
    while (queuedChunks.length > 0) {
      dispatchJobsChunkInternal(queuedChunks.shift()!);
    }
  };

  // Step-by-step timing so we can tell exactly where time goes.
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  console.log(`[stream] processParallel start, fileSizeMB=${fileSizeMB.toFixed(1)} workerCount=${workerCount}`);

  const prepassWorker = makePrepassWorker();
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
          rtcOffset: evt.rtcOffset as Float64Array,
          needsShift: evt.needsShift as boolean,
          buildingRotation: (evt.buildingRotation as number | null | undefined) ?? null,
        };
        console.log(`[stream] meta @ ${elapsed()}ms unitScale=${prepassMeta.unitScale} rtc=[${(prepassMeta.rtcOffset[0]).toFixed(0)},${(prepassMeta.rtcOffset[1]).toFixed(0)},${(prepassMeta.rtcOffset[2]).toFixed(0)}]`);
        sendStreamStartIfReady();
        wake();
      } else if (evt.type === 'jobs') {
        const jobsArr = evt.jobs as Uint32Array;
        const jobCount = Math.floor(jobsArr.length / 3);
        chunkArrivals++;
        totalDispatchedJobs += jobCount;
        if (firstChunkAt < 0) {
          firstChunkAt = elapsed();
          console.log(`[stream] first jobs chunk @ ${firstChunkAt}ms (${jobCount} jobs)`);
        }
        if (chunkArrivals % 10 === 1 || jobCount < 1000) {
          console.log(`[stream] chunk #${chunkArrivals} @ ${elapsed()}ms (+${jobCount} jobs, total ${totalDispatchedJobs})`);
        }
        dispatchJobsChunk(jobsArr);
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
            w.postMessage(
              {
                type: 'set-styles' as const,
                styleIds: sIds,
                styleColors: sColors,
                voidKeys: vKeys,
                voidCounts: vCounts,
                voidValues: vValues,
              },
              [sIds.buffer, sColors.buffer, vKeys.buffer, vCounts.buffer, vValues.buffer],
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
  prepassWorker.postMessage({ type: 'prepass-streaming', sharedBuffer, chunkSize: 50_000 });

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
  yield { type: 'complete', totalMeshes, coordinateInfo };
}
