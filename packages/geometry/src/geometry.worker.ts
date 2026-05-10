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

export type GeometryWorkerResponse =
  | GeometryWorkerBatchMessage
  | GeometryWorkerCompleteMessage
  | GeometryWorkerErrorMessage;

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

self.onmessage = async (e: MessageEvent<GeometryWorkerRequest>) => {
  try {
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

      // Zero-copy view over the shared bytes. Modern wasm-bindgen reads
      // SAB-backed Uint8Arrays directly; if the WASM call rejects the view on
      // some runtime, the catch block in `processBatch` retries with a copy.
      let localBytes: Uint8Array = viewSharedBytes(sharedBuffer);
      let sabFallbackTaken = false;

      const allMeshes: GeometryWorkerBatchMessage['meshes'] = [];
      const allTransferBuffers: ArrayBuffer[] = [];

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

          // First-line defence: if wasm-bindgen rejected the SAB-backed view,
          // materialise once and retry the SAME batch. Don't split, don't drop
          // the WASM instance — the failure is the marshaling layer, not the
          // geometry. Subsequent batches reuse `localBytes`, so the cost is
          // paid once per worker, matching the previous behaviour.
          if (!sabFallbackTaken && (localBytes.buffer instanceof SharedArrayBuffer)) {
            sabFallbackTaken = true;
            console.warn(
              `[Worker] processGeometryBatch rejected SAB view (${msg}), falling back to materialised copy`,
            );
            localBytes = materialiseSharedBytes(sharedBuffer);
            await processBatch(jobs);
            return;
          }

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
