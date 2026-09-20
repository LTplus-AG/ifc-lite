/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSyntheticDataStore, type IfcDataStore } from '@ifc-lite/parser';
import { parseLandXmlGeometry, type LandXmlGeometryPayload, type LandXmlSourceBuffer } from './landXmlIngest.js';

export interface LandXmlViewerModel extends LandXmlGeometryPayload {
  dataStore: IfcDataStore;
}

function attachSyntheticStore(payload: LandXmlGeometryPayload, fileSize: number): LandXmlViewerModel {
  return {
    ...payload,
    // LandXML is not IFC. This typed, entity-less store exists only so the
    // canonical federation finalizer can allocate a disjoint model id range;
    // no invented Ifc* type or alternate federation path is introduced.
    dataStore: createSyntheticDataStore({
      schemaVersion: 'IFC4',
      fileSize,
      entityCount: payload.geometryResult.meshes.length,
    }),
  };
}

export function parseLandXmlViewerModel(buffer: LandXmlSourceBuffer): LandXmlViewerModel {
  return attachSyntheticStore(parseLandXmlGeometry(buffer), buffer.byteLength);
}

/**
 * Parse off the UI thread in browsers. Node-based tests and non-window hosts
 * use the same synchronous implementation directly.
 */
export function parseLandXmlViewerModelAsync(buffer: LandXmlSourceBuffer): Promise<LandXmlViewerModel> {
  if (typeof Worker === 'undefined') return Promise.resolve(parseLandXmlViewerModel(buffer));
  const fileSize = buffer.byteLength;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./landXml.worker.ts', import.meta.url), { type: 'module' });
    const finish = (): void => worker.terminate();
    worker.onmessage = (event: MessageEvent<
      | { ok: true; payload: LandXmlGeometryPayload }
      | { ok: false; error: string }
    >) => {
      finish();
      if (event.data.ok) resolve(attachSyntheticStore(event.data.payload, fileSize));
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'LandXML worker failed'));
    };
    const transferable = typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer);
    worker.postMessage(buffer, transferable ? [buffer] : []);
  });
}
