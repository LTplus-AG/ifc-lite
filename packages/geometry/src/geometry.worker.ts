/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { initSync, IfcAPI } from '@ifc-lite/wasm';

export interface GeometryWorkerInitMessage {
  type: 'init';
  wasmModule?: WebAssembly.Module;
}

export interface GeometryWorkerProcessMessage {
  type: 'process';
  sharedBuffer: SharedArrayBuffer;
  jobsFlat: Uint32Array;      // [id, start, end, id, start, end, ...]
  unitScale: number;
  rtcX: number; rtcY: number; rtcZ: number;
  needsShift: boolean;
  voidKeys: Uint32Array;
  voidCounts: Uint32Array;
  voidValues: Uint32Array;
  styleIds: Uint32Array;
  styleColors: Uint8Array;
}

/**
 * Streaming-mode counterpart to `process`. The host sends `stream-start`
 * once with the same metadata (minus jobs), then any number of
 * `stream-chunk` messages with new job slices, and finally `stream-end`
 * to trigger the worker's `complete` + `memory` emit.
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
}

export interface GeometryWorkerStreamChunkMessage {
  type: 'stream-chunk';
  jobsFlat: Uint32Array;
}

export interface GeometryWorkerStreamEndMessage {
  type: 'stream-end';
}

export interface GeometryWorkerPrePassMessage {
  type: 'prepass' | 'prepass-fast' | 'prepass-streaming';
  sharedBuffer: SharedArrayBuffer;
  /** Jobs per chunk for `prepass-streaming` (defaults to 50_000). */
  chunkSize?: number;
}

export type GeometryWorkerRequest =
  | GeometryWorkerInitMessage
  | GeometryWorkerProcessMessage
  | GeometryWorkerStreamStartMessage
  | GeometryWorkerStreamChunkMessage
  | GeometryWorkerStreamEndMessage
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
  }[];
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

export type GeometryWorkerResponse =
  | GeometryWorkerBatchMessage
  | GeometryWorkerCompleteMessage
  | GeometryWorkerErrorMessage
  | GeometryWorkerMemoryMessage;

let api: IfcAPI | null = null;

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
  pendingMeshes: GeometryWorkerBatchMessage['meshes'];
  pendingTransfers: ArrayBuffer[];
  totalMeshesEmitted: number;
  cumulativeMeshBytes: number;
}

let activeSession: ProcessingSession | null = null;

/** Per-flush mesh batch size — fine-grained for fast TTFG, see `process` docs. */
const STREAM_BATCH_SIZE = 500;

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
 * Process a slice of jobsFlat with binary-split recovery. Mirrors the
 * pre-streaming behaviour: if WASM throws on the whole slice, split in
 * half and retry. Single-entity failures are skipped after one re-init
 * attempt because a stack overflow can corrupt the WASM heap.
 */
async function processBatch(session: ProcessingSession, jobs: Uint32Array): Promise<void> {
  const numJobs = Math.floor(jobs.length / 3);
  if (numJobs === 0) return;

  try {
    if (!api) {
      await init();
      api = new IfcAPI();
    }
    const collection = api.processGeometryBatch(
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

self.onmessage = async (e: MessageEvent<GeometryWorkerRequest>) => {
  try {
    if (e.data.type === 'prepass-streaming') {
      if (!api) { await init(); api = new IfcAPI(); }
      // Heartbeat: lets the host watchdog know the worker is alive even
      // before the first chunk lands.
      (self as unknown as Worker).postMessage({ type: 'prepass-progress', phase: 'parsing' });
      const sharedBuffer = e.data.sharedBuffer;
      const chunkSize = e.data.chunkSize ?? 50_000;

      // Forward Rust events 1:1 — the host (`geometry-parallel.ts`) treats
      // them as the streaming-prepass protocol. SAB-decode fallback mirrors
      // the existing `buildPrePassFast` path: try zero-copy view first, fall
      // back to a materialised copy only if wasm-bindgen rejects the view.
      let view = viewSharedBytes(sharedBuffer);
      let triedFallback = false;
      const onEvent = (event: unknown) => {
        (self as unknown as Worker).postMessage({ type: 'prepass-stream', event });
      };
      try {
        api.buildPrePassStreaming(view, onEvent, chunkSize);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!triedFallback) {
          triedFallback = true;
          console.warn(`[Worker] Streaming prepass with SAB view failed (${msg}), retrying with copy`);
          view = materialiseSharedBytes(sharedBuffer);
          api.buildPrePassStreaming(view, onEvent, chunkSize);
        } else {
          throw err;
        }
      }
      return;
    }

    if (e.data.type === 'prepass' || e.data.type === 'prepass-fast') {
      if (!api) { await init(); api = new IfcAPI(); }
      // Heartbeat: signals "worker alive, parser running" so the host watchdog
      // can distinguish a stuck pre-pass from one that's still working on a
      // multi-GB file.
      (self as unknown as Worker).postMessage({ type: 'prepass-progress', phase: 'parsing' });
      const sharedBuffer = e.data.sharedBuffer;
      const isFast = e.data.type === 'prepass-fast';
      // Fast pre-pass: only scan for entity locations (~1-2s)
      // Full pre-pass: also resolves styles + voids (~6s)
      let result: ReturnType<IfcAPI['buildPrePassOnce']>;
      try {
        const view = viewSharedBytes(sharedBuffer);
        result = isFast ? api.buildPrePassFast(view) : api.buildPrePassOnce(view);
      } catch (err) {
        // wasm-bindgen on some runtimes rejects SAB-backed views with a
        // TypeError. Retry once with a materialised copy so we never regress
        // versus the previous behaviour.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Worker] Prepass with SAB view failed (${msg}), retrying with copy`);
        const copy = materialiseSharedBytes(sharedBuffer);
        result = isFast ? api.buildPrePassFast(copy) : api.buildPrePassOnce(copy);
      }
      (self as unknown as Worker).postMessage({ type: 'prepass-result', result });
      return;
    }

    if (e.data.type === 'init') {
      if (e.data.wasmModule) {
        initSync({ module_or_path: e.data.wasmModule });
      } else {
        await init();
      }
      api = new IfcAPI();
      (self as unknown as Worker).postMessage({ type: 'ready' });
      return;
    }

    if (e.data.type === 'process') {
      if (!api) {
        await init();
        api = new IfcAPI();
      }
      const { sharedBuffer, jobsFlat, unitScale, rtcX, rtcY, rtcZ, needsShift,
              voidKeys, voidCounts, voidValues, styleIds, styleColors } = e.data;
      const session = startSession({
        sharedBuffer, unitScale, rtcX, rtcY, rtcZ, needsShift,
        voidKeys, voidCounts, voidValues, styleIds, styleColors,
      });
      activeSession = session;
      await processSliceStreaming(session, jobsFlat);
      emitSessionEnd(session);
      activeSession = null;
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
        throw new Error('stream-chunk received before stream-start');
      }
      await processSliceStreaming(activeSession, e.data.jobsFlat);
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
};
