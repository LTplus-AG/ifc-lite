/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Multi-worker parallel geometry processing.
 *
 * Spawns Web Workers that each get their own WASM instance and process
 * disjoint slices of the geometry entity list.  Batches are yielded as
 * they arrive from any worker, enabling progressive rendering while
 * utilizing multiple cores.
 */

import type { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData } from './types.js';
import type { StreamingGeometryEvent } from './index.js';
import { pickWorkerCount } from './worker-count.js';

/**
 * Run the full pre-pass in a dedicated worker, then fan geometry jobs
 * out to N workers and yield batches as they complete.
 *
 * @param buffer       Raw IFC file bytes
 * @param coordinator  CoordinateHandler used to accumulate bounds
 */
export async function* processParallel(
  buffer: Uint8Array,
  coordinator: CoordinateHandler,
  sharedRtcOffset?: { x: number; y: number; z: number },
  /**
   * Optional pre-allocated SharedArrayBuffer that the caller already shares
   * with other workers (e.g. the parser worker). When provided, we view it
   * directly and skip the copy. Must hold the same bytes as `buffer`.
   */
  existingSab?: SharedArrayBuffer,
): AsyncGenerator<StreamingGeometryEvent> {
  coordinator.reset();

  yield { type: 'start', totalEstimate: buffer.length / 1000 };
  yield { type: 'model-open', modelID: 0 };

  // Two ways to skip the file-size allocation+copy:
  //   1. Caller passed an explicit `existingSab` they already share with
  //      another worker (e.g. the parser worker via `useIfcLoader`).
  //   2. The input `buffer` is itself a Uint8Array view over a SAB — true
  //      when the entry path streamed the file directly into a SAB via
  //      `acquireFileBuffer` (issue #600 fix).
  // When neither applies, allocate a fresh SAB and copy bytes in.
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

  // ── PHASE 1: Full pre-pass in worker ──
  const makeWorker = () => new Worker(
    new URL('./geometry.worker.ts', import.meta.url),
    { type: 'module' },
  );

  // Pre-pass with heartbeat: the worker emits `prepass-progress` as soon as
  // parsing actually begins. We forward those as `progress` events so the
  // host watchdog (`useIfcLoader`) can distinguish a stuck pre-pass from one
  // that's still working on a multi-GB file. Heartbeats are queued and
  // drained between awaits so the `await` for the final result cooperates
  // with the generator's yields.
  const heartbeatQueue: StreamingGeometryEvent[] = [];
  let heartbeatWake: (() => void) | null = null;

  const prePassPromise = new Promise<any>((resolve, reject) => {
    const w = makeWorker();
    w.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (data.type === 'prepass-result') {
        w.terminate();
        resolve(data.result);
      } else if (data.type === 'prepass-progress') {
        heartbeatQueue.push({ type: 'progress', phase: 'prepass' });
        if (heartbeatWake) { heartbeatWake(); heartbeatWake = null; }
      } else if (data.type === 'error') {
        w.terminate();
        reject(new Error(data.message));
      }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage({ type: 'prepass', sharedBuffer });
  });

  // Race the prepass against a heartbeat-or-done signal; yield queued
  // heartbeats and re-arm. Exits when prePassPromise resolves/rejects.
  let prePassDone = false;
  let prePassResult: any;
  let prePassError: unknown = null;
  prePassPromise.then(
    (r) => { prePassResult = r; prePassDone = true; if (heartbeatWake) { heartbeatWake(); heartbeatWake = null; } },
    (err) => { prePassError = err; prePassDone = true; if (heartbeatWake) { heartbeatWake(); heartbeatWake = null; } },
  );

  while (!prePassDone || heartbeatQueue.length > 0) {
    while (heartbeatQueue.length > 0) {
      yield heartbeatQueue.shift()!;
    }
    if (prePassDone) break;
    await new Promise<void>((resolve) => { heartbeatWake = resolve; });
  }

  if (prePassError) {
    throw prePassError instanceof Error ? prePassError : new Error(String(prePassError));
  }

  if (!prePassResult || !prePassResult.jobs || prePassResult.totalJobs === 0) {
    const coordinateInfo = coordinator.getFinalCoordinateInfo();
    yield { type: 'complete', totalMeshes: 0, coordinateInfo };
    return;
  }

  const { jobs: jobsFlat, totalJobs, unitScale, rtcOffset, needsShift,
          voidKeys, voidCounts, voidValues, styleIds, styleColors } = prePassResult;

  // When a shared RTC offset is provided (2nd+ federated model), use it
  // instead of the per-model RTC. This ensures all models share the same
  // coordinate origin, giving pixel-perfect federation alignment.
  const useSharedRtc = sharedRtcOffset != null;
  const rtcX = useSharedRtc ? sharedRtcOffset.x : (rtcOffset?.[0] ?? 0);
  const rtcY = useSharedRtc ? sharedRtcOffset.y : (rtcOffset?.[1] ?? 0);
  const rtcZ = useSharedRtc ? sharedRtcOffset.z : (rtcOffset?.[2] ?? 0);
  const effectiveNeedsShift = useSharedRtc ? true : needsShift;

  yield {
    type: 'rtcOffset',
    rtcOffset: { x: rtcX, y: rtcY, z: rtcZ },
    hasRtc: effectiveNeedsShift,
  };

  // ── PHASE 2: Memory-budget-aware worker provisioning ──
  // Each worker holds a WASM heap that grows to ~1.5× file size while
  // building geometry. Spawning more workers than RAM can fund causes the
  // tab to OOM on big files (issue #600). `computeWorkerCount` clamps by
  // both core count and available memory; see `worker-count.ts` for the
  // budget formula.
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  const deviceMemoryGB = typeof navigator !== 'undefined' ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) : 8;
  const fileSizeMB = buffer.byteLength / (1024 * 1024);

  const workerCount = pickWorkerCount({
    fileSizeMB,
    cores,
    deviceMemoryGB,
    totalJobs,
  });
  const jobsPerWorker = Math.ceil(totalJobs / workerCount);

  const chunks: [number, number][] = [];
  for (let i = 0; i < workerCount; i++) {
    const start = i * jobsPerWorker;
    const end = Math.min(start + jobsPerWorker, totalJobs);
    if (start < end) chunks.push([start, end]);
  }

  // Queue-based async generator: workers push batches, generator yields them
  const batchQueue: MeshData[][] = [];
  /** Per-worker memory messages, drained alongside batches so the receiver
   * can aggregate WASM heap bytes across the pool. */
  const memoryQueue: { workerIndex: number; wasmHeapBytes: number; meshBytes: number }[] = [];
  let resolveWaiting: (() => void) | null = null;
  let workersCompleted = 0;
  let totalMeshes = 0;
  let workerError: Error | null = null;

  const workers: Worker[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const [jobStart, jobEnd] = chunks[i];
    if (jobStart >= jobEnd) {
      workersCompleted++;
      continue;
    }
    const workerJobs = jobsFlat.slice(jobStart * 3, jobEnd * 3);

    const worker = new Worker(
      new URL('./geometry.worker.ts', import.meta.url),
      { type: 'module' }
    );

    workers.push(worker);
    const workerIndex = i;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'memory') {
        memoryQueue.push({ workerIndex, wasmHeapBytes: msg.wasmHeapBytes, meshBytes: msg.meshBytes });
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
        return;
      }
      if (msg.type === 'batch') {
        // Convert transferable data back to MeshData[]
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
          batchQueue.push(meshes);
          if (resolveWaiting) {
            resolveWaiting();
            resolveWaiting = null;
          }
        }
      } else if (msg.type === 'complete') {
        totalMeshes += msg.totalMeshes;
        workersCompleted++;
        worker.terminate();
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      } else if (msg.type === 'error') {
        workerError = new Error(`Geometry worker error: ${msg.message}`);
        workersCompleted++;
        worker.terminate();
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      }
    };

    worker.onerror = (e) => {
      workerError = new Error(`Geometry worker failed: ${e.message}`);
      workersCompleted++;
      worker.terminate();
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    };

    // Send work — sharedBuffer is zero-copy, typed arrays are transferred
    worker.postMessage({
      type: 'process' as const,
      sharedBuffer,
      jobsFlat: workerJobs,
      unitScale,
      rtcX, rtcY, rtcZ,
      needsShift: effectiveNeedsShift,
      voidKeys, voidCounts, voidValues,
      styleIds, styleColors,
    });
  }

  // Yield batches as they arrive from any worker
  while (true) {
    while (memoryQueue.length > 0) {
      const memMsg = memoryQueue.shift()!;
      yield {
        type: 'workerMemory',
        workerIndex: memMsg.workerIndex,
        wasmHeapBytes: memMsg.wasmHeapBytes,
        meshBytes: memMsg.meshBytes,
      };
    }
    while (batchQueue.length > 0) {
      const batch = batchQueue.shift()!;
      coordinator.processMeshesIncremental(batch);
      const coordinateInfo = coordinator.getCurrentCoordinateInfo();
      yield {
        type: 'batch',
        meshes: batch,
        totalSoFar: totalMeshes,
        coordinateInfo: coordinateInfo || undefined,
      };
    }

    if (workerError) {
      // Terminate remaining workers
      for (const w of workers) {
        try { w.terminate(); } catch { /* cleanup — safe to ignore */ }
      }
      throw workerError;
    }

    if (workersCompleted >= chunks.length && batchQueue.length === 0) {
      break;
    }

    await new Promise<void>((resolve) => {
      resolveWaiting = resolve;
    });
  }

  const coordinateInfo = coordinator.getFinalCoordinateInfo();
  yield { type: 'complete', totalMeshes, coordinateInfo };
}
