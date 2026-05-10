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

export interface GeometryWorkerPrePassMessage {
  type: 'prepass' | 'prepass-fast';
  sharedBuffer: SharedArrayBuffer;
}

export type GeometryWorkerRequest = GeometryWorkerInitMessage | GeometryWorkerProcessMessage | GeometryWorkerPrePassMessage;

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

self.onmessage = async (e: MessageEvent<GeometryWorkerRequest>) => {
  try {
    if (e.data.type === 'prepass' || e.data.type === 'prepass-fast') {
      if (!api) { await init(); api = new IfcAPI(); }
      const localBuffer = new Uint8Array(e.data.sharedBuffer.byteLength);
      localBuffer.set(new Uint8Array(e.data.sharedBuffer));
      // Fast pre-pass: only scan for entity locations (~1-2s)
      // Full pre-pass: also resolves styles + voids (~6s)
      const result = e.data.type === 'prepass-fast'
        ? api.buildPrePassFast(localBuffer)
        : api.buildPrePassOnce(localBuffer);
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

      // Copy shared bytes to local buffer (Firefox requires this for typed array ops)
      const localBytes = new Uint8Array(sharedBuffer.byteLength);
      localBytes.set(new Uint8Array(sharedBuffer));

      const allMeshes: GeometryWorkerBatchMessage['meshes'] = [];
      const allTransferBuffers: ArrayBuffer[] = [];
      let cumulativeMeshBytes = 0;

      /** Extract meshes from a MeshCollection into our arrays */
      const collectMeshes = (collection: ReturnType<IfcAPI['processGeometryBatch']>) => {
        for (let i = 0; i < collection.length; i++) {
          const mesh = collection.get(i);
          if (!mesh) continue;
          const positions = new Float32Array(mesh.positions);
          const normals = new Float32Array(mesh.normals);
          const indices = new Uint32Array(mesh.indices);
          allMeshes.push({
            expressId: mesh.expressId,
            ifcType: mesh.ifcType,
            positions, normals, indices,
            color: [mesh.color[0], mesh.color[1], mesh.color[2], mesh.color[3]],
          });
          allTransferBuffers.push(positions.buffer, normals.buffer, indices.buffer);
          cumulativeMeshBytes += positions.byteLength + normals.byteLength + indices.byteLength;
          mesh.free();
        }
        collection.free();
      };

      /**
       * Process a slice of jobsFlat with automatic sub-batch splitting on failure.
       * Uses binary-split strategy: try the whole slice, if it fails split in half
       * and recurse. Only falls back to single-entity processing for the smallest
       * failing chunk. This avoids rebuilding the entity index per-entity (expensive
       * for large files — each rebuild scans the entire file).
       */
      const processBatch = async (jobs: Uint32Array): Promise<void> => {
        const numJobs = Math.floor(jobs.length / 3);
        if (numJobs === 0) return;

        try {
          if (!api) {
            await init();
            api = new IfcAPI();
          }
          const collection = api.processGeometryBatch(
            localBytes, jobs, unitScale,
            rtcX, rtcY, rtcZ, needsShift,
            voidKeys, voidCounts, voidValues,
            styleIds, styleColors,
          );
          collectMeshes(collection);
        } catch (err) {
          const msg = (err as Error).message;

          if (numJobs === 1) {
            // Single entity failed — skip it
            console.warn(`[Worker] Skipping entity #${jobs[0]}: ${msg}`);
            // WASM instance may be corrupted after stack overflow — force re-init
            api = null;
            return;
          }

          // Split in half and retry each half
          console.warn(
            `[Worker] Batch of ${numJobs} entities failed (${msg}), splitting…`,
          );
          // WASM may be corrupted — force re-init before retrying
          api = null;

          const mid = Math.floor(numJobs / 2) * 3;
          await processBatch(jobs.slice(0, mid));
          await processBatch(jobs.slice(mid));
        }
      };

      await processBatch(jobsFlat);

      (self as unknown as Worker).postMessage(
        { type: 'batch', meshes: allMeshes } as GeometryWorkerBatchMessage,
        allTransferBuffers,
      );
      // Memory snapshot is best-effort: read the WASM heap size if the
      // instance survived. After a binary-split crash-and-reset `api` is
      // null, in which case we report 0 and let the aggregator note the
      // gap. We post `memory` BEFORE `complete` so the receiver doesn't
      // race the worker.terminate() that follows `complete`.
      let wasmHeapBytes = 0;
      try {
        const wasmMemory = api?.getMemory() as { buffer?: ArrayBuffer } | undefined;
        wasmHeapBytes = wasmMemory?.buffer?.byteLength ?? 0;
      } catch {
        /* memory accounting only — safe to ignore */
      }
      (self as unknown as Worker).postMessage(
        { type: 'memory', meshBytes: cumulativeMeshBytes, wasmHeapBytes } as GeometryWorkerMemoryMessage,
      );
      (self as unknown as Worker).postMessage(
        { type: 'complete', totalMeshes: allMeshes.length } as GeometryWorkerCompleteMessage,
      );
    }
  } catch (err) {
    (self as unknown as Worker).postMessage(
      { type: 'error', message: err instanceof Error ? err.message : String(err) } as GeometryWorkerErrorMessage,
    );
  }
};
