/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseLandXmlGeometry, type LandXmlGeometryPayload, type LandXmlSourceBuffer } from './landXmlIngest.js';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<LandXmlSourceBuffer>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event: MessageEvent<LandXmlSourceBuffer>): void => {
  try {
    const payload = parseLandXmlGeometry(event.data);
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
