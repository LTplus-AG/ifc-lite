/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadRetainedEngine } from '../../../../../packages/wasm/retained.js';
import { convertMeshCollectionToBatch } from '../../../../../packages/geometry/src/geometry-coordinate';
import type { RetainedHostRequest, RetainedHostResponse, RetainedModelSession, RetainedSessionModule } from './retained-protocol';

let engine: RetainedSessionModule | undefined;
let session: RetainedModelSession | undefined;
let running = false;
const send = (message: RetainedHostResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

self.onmessage = async ({ data }: MessageEvent<RetainedHostRequest>) => {
  const { runId, options } = data;
  if (running) {
    send({ runId, kind: 'error', code: 'busy', message: 'A retained model is already running' });
    return;
  }
  running = true;
  let phase: 'engine_missing' | 'startup' | 'worker_crash' = 'engine_missing';
  try {
    if (!engine) {
      // Temporary structural boundary until M2-A supplies the generated d.ts.
      engine = await loadRetainedEngine({ moduleUrl: '/retained-engine/pkg-retained/ifc-lite.js' }) as unknown as RetainedSessionModule;
    }
    phase = 'startup';
    session ??= new engine.RetainedModelSession();
    const pending = session.run(data.bytes, options, (event) => {
      phase = 'worker_crash';
      if (event.kind === 'published') {
        // Frees every MeshDataJs and the collection, including on throw.
        const meshes = convertMeshCollectionToBatch(event.meshes);
        const buffers = new Set<ArrayBuffer>();
        for (const mesh of meshes) {
          for (const array of [mesh.positions, mesh.normals, mesh.indices, mesh.uvs, mesh.texture?.rgba]) {
            if (array?.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
          }
        }
        send({ ...event, runId, meshes }, [...buffers]);
      } else {
        send({ ...event, runId });
      }
    });
    // wasm-bindgen copied the input synchronously; retain no JS source during
    // the awaited product stream. The caller keeps its own original buffer.
    data.bytes = new Uint8Array();
    await pending;
    send({ runId, kind: 'workerMemory', wasmHeapBytes: engine.get_memory().buffer.byteLength });
    send({ runId, kind: 'complete', cancelled: false });
  } catch (error) {
    send({ runId, kind: 'error', code: phase, message: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
};
