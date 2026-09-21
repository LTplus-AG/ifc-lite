/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import { parseLandXmlGeometry, type LandXmlGeometryPayload, type LandXmlSourceBuffer } from './landXmlIngest.js';
import { parseLandXmlSourceWithApi } from './landXmlWasm.js';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<LandXmlSourceBuffer>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.onmessage = async (event: MessageEvent<LandXmlSourceBuffer>): Promise<void> => {
  try {
    // A worker owns a separate WASM instance. Pass the original bytes directly:
    // ArrayBuffers are transferred by the client and SharedArrayBuffers remain shared.
    await init();
    const api = new IfcAPI();
    let payload: LandXmlGeometryPayload;
    try {
      payload = parseLandXmlGeometry(parseLandXmlSourceWithApi(api, event.data));
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
