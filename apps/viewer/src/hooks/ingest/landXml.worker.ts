/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import { parseLandXmlGeometry, preflightLandXmlGeometry, type LandXmlGeometryPayload, type LandXmlSourceBuffer } from './landXmlIngest.js';
import { parseLandXmlSourceWithApi } from './landXmlWasm.js';
import { parseLandXmlSourceBlobWithApi } from './landXmlBlobCursor.js';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<LandXmlSourceBuffer>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

interface LandXmlBlobWorkerRequest {
  file: Blob;
}

function isBlobRequest(value: unknown): value is LandXmlBlobWorkerRequest {
  return typeof value === 'object' && value !== null && 'file' in value && (value as { file?: unknown }).file instanceof Blob;
}

workerScope.onmessage = async (event: MessageEvent<LandXmlSourceBuffer | LandXmlBlobWorkerRequest>): Promise<void> => {
  try {
    // A worker owns a separate WASM instance. Pass the original bytes directly:
    // ArrayBuffers are transferred by the client and SharedArrayBuffers remain shared.
    await init();
    const api = new IfcAPI();
    let payload: LandXmlGeometryPayload;
    try {
      const document = isBlobRequest(event.data)
        ? await (async () => {
          // Pass one derives the exact component envelope and canonical
          // dominant frame while releasing every mesh immediately. Pass two
          // rebuilds the source against that frozen policy; a mismatch is a
          // hard failure, never a partially publishable model.
          const preflight = preflightLandXmlGeometry(await parseLandXmlSourceBlobWithApi(api, event.data.file, {
            onProgress: (loadedBytes, totalBytes) => workerScope.postMessage({ progress: { loadedBytes, totalBytes: totalBytes * 2 } }),
          }));
          const secondPass = await parseLandXmlSourceBlobWithApi(api, event.data.file, {
            onProgress: (loadedBytes, totalBytes) => workerScope.postMessage({ progress: { loadedBytes: totalBytes + loadedBytes, totalBytes: totalBytes * 2 } }),
          });
          return { document: secondPass, preflight };
        })
        // TODO(remove-by: #5050 completion, owner: LandXML)
        // Buffer callers are retained only for the test/legacy compatibility
        // adapter; the canonical loadFile LandXML path sends a Blob request.
        : { document: parseLandXmlSourceWithApi(api, event.data), preflight: undefined };
      payload = parseLandXmlGeometry(document.document, document.preflight);
    } finally {
      api.free();
    }
    const transfer: Transferable[] = [];
    for (const mesh of payload.geometryResult.meshes) {
      transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer);
    }
    workerScope.postMessage({ ok: true, payload } satisfies { ok: true; payload: LandXmlGeometryPayload }, transfer);
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
