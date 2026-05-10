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

export async function* processParallel(
  buffer: Uint8Array,
  coordinator: CoordinateHandler,
  sharedRtcOffset?: { x: number; y: number; z: number },
  /** Optional pre-allocated SAB the caller already shares with another worker. */
  existingSab?: SharedArrayBuffer,
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

  const makeWorker = () => new Worker(
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
  /** Chunks that arrived before `meta` resolved — drained once stream-start fires. */
  const queuedChunks: Uint32Array[] = [];

  const installWorkerHandlers = (worker: Worker, workerIndex: number) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
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
      if (msg.type === 'ready') {
        // WASM init handshake — purely informational, no action needed.
        return;
      }
      if (msg.type === 'batch') {
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
        totalMeshes += msg.totalMeshes;
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
  const workerCount = pickWorkerCount({ fileSizeMB, cores, deviceMemoryGB, totalJobs: estimatedJobs });

  const workers: Worker[] = [];
  for (let i = 0; i < workerCount; i++) {
    const worker = makeWorker();
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

    // Drain any chunks that arrived before meta. (The Rust streaming
    // pre-pass always emits `meta` before the first `jobs` event, so this
    // is defensive — but if it ever flips we won't lose jobs.)
    while (queuedChunks.length > 0) {
      dispatchJobsChunkInternal(queuedChunks.shift()!);
    }
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
    if (!streamStartSentToWorkers) {
      // Buffer until meta resolves and stream-start has been posted.
      queuedChunks.push(jobs);
      return;
    }
    dispatchJobsChunkInternal(jobs);
  };

  const prepassWorker = makeWorker();
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
        sendStreamStartIfReady();
        wake();
      } else if (evt.type === 'jobs') {
        dispatchJobsChunk(evt.jobs as Uint32Array);
      } else if (evt.type === 'complete') {
        prepassJobsTotal = evt.totalJobs as number;
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
    sendStreamEnd();
    prepassWorker.terminate();
    wake();
  };

  // Dispatch the streaming pre-pass.
  // Smaller chunks (5 K) give the host many opportunities to keep all
  // workers busy throughout the pre-pass scan; combined with the
  // per-chunk worker fan-out above this keeps the pool saturated even
  // when total geometry job count is modest (e.g. 92 K on the 986 MB
  // test file).
  prepassWorker.postMessage({ type: 'prepass-streaming', sharedBuffer, chunkSize: 5_000 });

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

    // Once the Rust `complete` event has been observed, signal end-of-stream
    // to all workers exactly once.
    if (!prepassCompleteSeen && prepassJobsTotal > 0) {
      prepassCompleteSeen = true;
      onPrepassComplete();
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
