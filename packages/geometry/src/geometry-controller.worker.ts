/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single-controller geometry worker (Phase 2 of single-controller-rayon-design.md).
 *
 * Replaces the N-independent-Web-Workers pool. ONE WASM instance with
 * an internal rayon thread pool of (navigator.hardwareConcurrency - 1)
 * helper threads. All `processGeometryBatchParallel` work happens
 * inside this worker; rayon's `par_iter` distributes per-entity work
 * across the helpers via shared memory.
 *
 * Message protocol is INTENTIONALLY identical to `geometry.worker.ts`
 * so the host (`geometry-parallel.ts`) can swap implementations behind
 * a feature flag without changing the dispatch / event-collection
 * code. The controller accepts the same set: `init`, `stream-start`,
 * `stream-chunk`, `stream-end`, `set-styles`, `set-entity-index`.
 *
 * Why this matters: the per-worker entity-index FxHashMap (~600 MB
 * per worker on the 986 MB test file) was triplicated across 3
 * workers. Single controller holds ONE copy. Total peakWasm should
 * drop from ~5.3 GB to ~3 GB. Plus rayon work-stealing replaces
 * the contention pattern that capped useful workers at 3 even on
 * 10-core hosts.
 */

// Import the THREADED bundle. The viewer's vite.config.ts maps
// `@ifc-lite/wasm-threaded` to `packages/wasm-threaded/pkg/ifc-lite.js`.
// (See vite.config.ts alias added by Phase 2 wiring.)
import init, { initSync, IfcAPI, initThreadPool } from '@ifc-lite/wasm-threaded';

// Optional: import the bench function (only present in threaded build)
type BenchApi = {
  benchmarkPureCpuParallelism?: (numTasks: number) => Float64Array;
};

import type {
  GeometryWorkerInitMessage,
  GeometryWorkerProcessMessage,
  GeometryWorkerStreamStartMessage,
  GeometryWorkerStreamChunkMessage,
  GeometryWorkerStreamEndMessage,
  GeometryWorkerSetStylesMessage,
  GeometryWorkerSetEntityIndexMessage,
  GeometryWorkerPrePassMessage,
  GeometryWorkerBatchMessage,
  GeometryWorkerCompleteMessage,
  GeometryWorkerErrorMessage,
  GeometryWorkerMemoryMessage,
} from './geometry.worker.js';

// Reuse the same message-type union shape as the N-worker bundle.
export type GeometryControllerRequest =
  | GeometryWorkerInitMessage
  | GeometryWorkerProcessMessage
  | GeometryWorkerStreamStartMessage
  | GeometryWorkerStreamChunkMessage
  | GeometryWorkerStreamEndMessage
  | GeometryWorkerSetStylesMessage
  | GeometryWorkerSetEntityIndexMessage
  | GeometryWorkerPrePassMessage;

export type GeometryControllerResponse =
  | GeometryWorkerBatchMessage
  | GeometryWorkerCompleteMessage
  | GeometryWorkerErrorMessage
  | GeometryWorkerMemoryMessage;

let api: IfcAPI | null = null;
let threadPoolReady = false;

/**
 * Per-load processing session — same shape as `geometry.worker.ts`'s
 * `ProcessingSession`. Held across stream-chunk messages so the
 * controller knows the unitScale / RTC / styles for each call.
 */
interface ControllerSession {
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
  pendingMeshes: GeometryWorkerBatchMessage['meshes'];
  pendingTransfers: ArrayBuffer[];
  totalMeshesEmitted: number;
  cumulativeMeshBytes: number;
}

let activeSession: ControllerSession | null = null;

function viewSharedBytes(sharedBuffer: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(sharedBuffer);
}

function materialiseSharedBytes(sharedBuffer: SharedArrayBuffer): Uint8Array {
  const local = new Uint8Array(sharedBuffer.byteLength);
  local.set(new Uint8Array(sharedBuffer));
  return local;
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
}): ControllerSession {
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
    pendingMeshes: [],
    pendingTransfers: [],
    totalMeshesEmitted: 0,
    cumulativeMeshBytes: 0,
  };
}

function flushPending(session: ControllerSession): void {
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
  session: ControllerSession,
  collection: ReturnType<IfcAPI['processGeometryBatch']>,
): void {
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    if (!mesh) continue;
    const positions = new Float32Array(mesh.positions);
    const normals = new Float32Array(mesh.normals);
    const indices = new Uint32Array(mesh.indices);
    session.pendingMeshes.push({
      expressId: mesh.expressId,
      ifcType: mesh.ifcType,
      positions, normals, indices,
      color: [mesh.color[0], mesh.color[1], mesh.color[2], mesh.color[3]],
    });
    session.pendingTransfers.push(positions.buffer, normals.buffer, indices.buffer);
    session.cumulativeMeshBytes += positions.byteLength + normals.byteLength + indices.byteLength;
    mesh.free();
  }
  collection.free();
}

/**
 * Run one chunk through the rayon-parallel batch entry. Same binary-
 * split recovery as the N-worker path: if WASM rejects the whole slice
 * (typical: SAB-view incompatible with this runtime), fall back to a
 * materialised copy; on per-entity failure, halve and retry.
 */
async function processBatchParallel(
  session: ControllerSession,
  jobs: Uint32Array,
): Promise<void> {
  const numJobs = Math.floor(jobs.length / 3);
  if (numJobs === 0) return;

  try {
    if (!api) {
      throw new Error('controller API not initialised before stream-chunk');
    }
    type ParallelApi = {
      processGeometryBatchParallel: typeof IfcAPI.prototype.processGeometryBatch;
    };
    const collection = (api as unknown as ParallelApi).processGeometryBatchParallel(
      session.localBytes, jobs, session.unitScale,
      session.rtcX, session.rtcY, session.rtcZ, session.needsShift,
      session.voidKeys, session.voidCounts, session.voidValues,
      session.styleIds, session.styleColors,
    );
    collectMeshes(session, collection);
  } catch (err) {
    const msg = (err as Error).message;
    if (!session.sabFallbackTaken && session.localBytes.buffer instanceof SharedArrayBuffer) {
      session.sabFallbackTaken = true;
      console.warn(`[controller] processGeometryBatchParallel rejected SAB view (${msg}), copying`);
      session.localBytes = materialiseSharedBytes(session.sharedBuffer);
      await processBatchParallel(session, jobs);
      return;
    }
    if (numJobs === 1) {
      console.warn(`[controller] skipping entity #${jobs[0]}: ${msg}`);
      return;
    }
    console.warn(`[controller] batch of ${numJobs} entities failed (${msg}), splitting…`);
    const mid = Math.floor(numJobs / 2) * 3;
    await processBatchParallel(session, jobs.slice(0, mid));
    await processBatchParallel(session, jobs.slice(mid));
  }
}

/**
 * Run a slice in STREAM_BATCH_SIZE chunks, flushing after each. Same
 * cadence as the N-worker path so downstream React/render code sees
 * familiar timing.
 */
const STREAM_BATCH_SIZE = 1_000_000;

async function processSliceStreaming(
  session: ControllerSession,
  jobsFlat: Uint32Array,
): Promise<void> {
  const totalJobs = Math.floor(jobsFlat.length / 3);
  for (let jobOffset = 0; jobOffset < totalJobs; jobOffset += STREAM_BATCH_SIZE) {
    const start = jobOffset * 3;
    const end = Math.min(start + STREAM_BATCH_SIZE * 3, jobsFlat.length);
    await processBatchParallel(session, jobsFlat.slice(start, end));
    flushPending(session);
  }
}

function emitSessionEnd(session: ControllerSession): void {
  flushPending(session);
  // Memory snapshot — single WASM heap (vs N-worker pool sums).
  let wasmHeapBytes = 0;
  try {
    const memJs = api?.getMemory();
    const buf = (memJs as unknown as { buffer?: ArrayBufferLike })?.buffer;
    wasmHeapBytes = buf?.byteLength ?? 0;
  } catch { /* memory probe is best-effort */ }
  (self as unknown as Worker).postMessage({
    type: 'memory',
    wasmHeapBytes,
    meshBytes: session.cumulativeMeshBytes,
  } as GeometryWorkerMemoryMessage);
  (self as unknown as Worker).postMessage({
    type: 'complete',
    totalMeshes: session.totalMeshesEmitted,
  } as GeometryWorkerCompleteMessage);
}

/**
 * Tail-promise serialiser — copied from `geometry.worker.ts`. Web
 * Worker `onmessage` is fire-and-forget; without serialisation, an
 * async handler for `stream-start` (which awaits init() + initThreadPool)
 * can be overtaken by a synchronous `stream-chunk` handler that
 * dispatches before the session is ready.
 */
let messageTail: Promise<void> = Promise.resolve();

self.onmessage = (rawEvent: MessageEvent<GeometryControllerRequest>) => {
  const e = rawEvent;
  messageTail = messageTail.then(async () => {
    try {
      if (e.data.type === 'init') {
        if (e.data.wasmModule) {
          initSync({ module_or_path: e.data.wasmModule });
        } else {
          await init();
        }
        api = new IfcAPI();

        // Spin up the rayon thread pool. Per the design (and upstream
        // guidance from issue #36), call from inside this worker (NOT
        // main thread) to dodge the Atomics.wait deadlock that fires
        // when initThreadPool runs on the main thread.
        //
        // Thread count: hardwareConcurrency - 1 to leave one core for
        // main-thread render. Wrap with retry-25ms-backoff x5 in case
        // we hit transient deadlocks anyway.
        const cores = (typeof navigator !== 'undefined'
          ? (navigator.hardwareConcurrency ?? 4)
          : 4);
        const targetThreads = Math.max(1, cores - 1);
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            const t0 = performance.now();
            await initThreadPool(targetThreads);
            console.log(`[controller] rayon pool ready (${targetThreads} threads, attempt ${attempt}) @ ${Math.round(performance.now() - t0)}ms`);
            threadPoolReady = true;
            break;
          } catch (err) {
            console.warn(`[controller] initThreadPool attempt ${attempt} failed:`, err);
            if (attempt === 5) {
              console.error('[controller] all initThreadPool attempts exhausted — par_iter will run serial');
            } else {
              await new Promise((r) => setTimeout(r, 25));
            }
          }
        }
        // Phase 2 microbenchmark — run a CPU-pure parallel task to
        // measure rayon's actual speedup on this hardware. Helps
        // distinguish "rayon is broken" vs "our workload doesn't fit
        // rayon" when stream tail is slow.
        try {
          const benchApi = api as unknown as BenchApi;
          if (typeof benchApi.benchmarkPureCpuParallelism === 'function') {
            // 9 tasks → one per helper thread — best case for scaling.
            benchApi.benchmarkPureCpuParallelism(9);
          }
        } catch (err) {
          console.warn('[controller] microbench failed:', err);
        }

        (self as unknown as Worker).postMessage({ type: 'ready' });
        return;
      }

      if (e.data.type === 'stream-start') {
        if (!api) {
          await init();
          api = new IfcAPI();
        }
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
        });
        return;
      }

      if (e.data.type === 'stream-chunk') {
        if (!activeSession) {
          throw new Error('stream-chunk before stream-start');
        }
        await processSliceStreaming(activeSession, e.data.jobsFlat);
        return;
      }

      if (e.data.type === 'stream-end') {
        if (!activeSession) return;
        emitSessionEnd(activeSession);
        activeSession = null;
        return;
      }

      if (e.data.type === 'set-styles') {
        if (!activeSession) return;
        activeSession.styleIds = e.data.styleIds;
        activeSession.styleColors = e.data.styleColors;
        activeSession.voidKeys = e.data.voidKeys;
        activeSession.voidCounts = e.data.voidCounts;
        activeSession.voidValues = e.data.voidValues;
        return;
      }

      if (e.data.type === 'set-entity-index') {
        if (!api) {
          await init();
          api = new IfcAPI();
        }
        // Eager FxHashMap build — happens during the styles wait so
        // by the time stream-chunk arrives the cache is hot.
        api.setEntityIndex(e.data.ids, e.data.starts, e.data.lengths);
        return;
      }

      // process / prepass-* message types are NOT handled by the
      // controller path — those are pre-pass-only contracts that stay
      // on the existing pre-pass worker (geometry.worker.ts). The
      // controller is for stream-chunk dispatch only.
      console.warn(`[controller] ignoring unhandled message type: ${e.data.type}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[controller] handler error:', err);
      (self as unknown as Worker).postMessage({
        type: 'error',
        message: msg,
      } as GeometryWorkerErrorMessage);
    }
  });
};

// Mark threadPoolReady reachable to silence potential unused warning
// when the future Phase 3 code references it for back-pressure.
void threadPoolReady;
