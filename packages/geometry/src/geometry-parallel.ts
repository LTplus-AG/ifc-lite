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
): AsyncGenerator<StreamingGeometryEvent> {
  coordinator.reset();

  yield { type: 'start', totalEstimate: buffer.length / 1000 };
  yield { type: 'model-open', modelID: 0 };

  // Copy file bytes into SharedArrayBuffer for zero-copy sharing with workers
  const sharedBuffer = new SharedArrayBuffer(buffer.byteLength);
  new Uint8Array(sharedBuffer).set(buffer);

  // ── PHASE 1: Full pre-pass in worker ──
  const makeWorker = () => new Worker(
    new URL('./geometry.worker.ts', import.meta.url),
    { type: 'module' },
  );

  const prePassResult = await new Promise<any>((resolve, reject) => {
    const w = makeWorker();
    w.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'prepass-result') { w.terminate(); resolve(e.data.result); }
      else if (e.data.type === 'error') { w.terminate(); reject(new Error(e.data.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage({ type: 'prepass', sharedBuffer });
  });

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

  // ── PHASE 2: Dynamic worker provisioning based on device capability ──
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  const deviceMemoryGB = typeof navigator !== 'undefined' ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) : 8;
  const fileSizeGB = buffer.byteLength / (1024 * 1024 * 1024);

  // Determine optimal workers:
  // - Desktop (16+ cores, 16+ GB): up to 8 workers
  // - Laptop (8 cores, 8 GB): 2-4 workers (avoid thermal throttling on fanless)
  // - Low-end (4 cores, 4 GB): 1-2 workers
  // - Large files need more memory per worker, so fewer workers
  let maxWorkers: number;
  if (cores >= 16 && deviceMemoryGB >= 16) {
    maxWorkers = Math.min(8, Math.floor(cores / 2));
  } else if (cores >= 8 && deviceMemoryGB >= 8) {
    // MacBook Air M-series: 8 cores but fanless → throttles with too many workers
    // Use 3 workers: enough parallelism without severe throttling
    maxWorkers = fileSizeGB > 0.5 ? 2 : 3;
  } else {
    maxWorkers = Math.max(1, Math.min(2, Math.floor(cores / 2)));
  }

  const workerCount = Math.min(maxWorkers, totalJobs);
  const jobsPerWorker = Math.ceil(totalJobs / workerCount);

  const chunks: [number, number][] = [];
  for (let i = 0; i < workerCount; i++) {
    const start = i * jobsPerWorker;
    const end = Math.min(start + jobsPerWorker, totalJobs);
    if (start < end) chunks.push([start, end]);
  }

  // Queue-based async generator: workers push batches, generator yields them
  const batchQueue: MeshData[][] = [];
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

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
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
