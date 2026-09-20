/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSyntheticDataStore, type IfcDataStore } from '@ifc-lite/parser';
import type { LandXmlGeometryPayload, LandXmlSourceBuffer } from './landXmlIngest.js';
import { parseLandXmlGeometry } from './landXmlIngest.js';
import { parseLandXmlTinInCurrentRealm } from './landXmlWasm.js';
import { spatialMetadataFromLandXml, spatialReferenceFromSourceMetadata } from './sourceSpatialReference.js';
import type { ModelSpatialReference } from '@ifc-lite/geometry';

export interface LandXmlViewerModel extends LandXmlGeometryPayload {
  dataStore: IfcDataStore;
  spatialReference?: ModelSpatialReference;
}

function attachSyntheticStore(
  payload: LandXmlGeometryPayload,
  fileSize: number,
  spatialReference?: ModelSpatialReference,
): LandXmlViewerModel {
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
    ...(spatialReference ? { spatialReference } : {}),
  };
}

/**
 * Parse off the UI thread in browsers. Worker-less hosts use the same WASM
 * parser in their own realm, so there is no DOM/TypeScript parser fallback.
 */
export function parseLandXmlViewerModelAsync(
  buffer: LandXmlSourceBuffer,
  isCurrent: () => boolean = () => true,
): Promise<LandXmlViewerModel> {
  // This metadata is read from the source document, not fabricated onto the
  // synthetic IFC store. Only a complete horizontal+vertical declaration may
  // enter federation; otherwise the source stays explicit-unknown.
  const metadata = spatialMetadataFromLandXml(new TextDecoder().decode(buffer));
  const spatialReference = metadata.horizontalId && metadata.verticalId
    ? spatialReferenceFromSourceMetadata(metadata)
    : undefined;
  if (typeof Worker === 'undefined') {
    if (!isCurrent()) return Promise.reject(new Error('LandXML parsing cancelled'));
    return parseLandXmlTinInCurrentRealm(buffer).then((parsed) => {
      if (!isCurrent()) throw new Error('LandXML parsing cancelled');
      return attachSyntheticStore(parseLandXmlGeometry(parsed), buffer.byteLength, spatialReference);
    });
  }
  const fileSize = buffer.byteLength;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./landXml.worker.ts', import.meta.url), { type: 'module' });
    let finished = false;
    let cancellationPoll: ReturnType<typeof setInterval> | undefined;
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      if (cancellationPoll !== undefined) clearInterval(cancellationPoll);
      worker.terminate();
      return true;
    };
    cancellationPoll = setInterval(() => {
      if (isCurrent()) return;
      if (finish()) reject(new Error('LandXML parsing cancelled'));
    }, 25);
    worker.onmessage = (event: MessageEvent<
      | { ok: true; payload: LandXmlGeometryPayload }
      | { ok: false; error: string }
    >) => {
      if (!finish()) return;
      if (event.data.ok) resolve(attachSyntheticStore(event.data.payload, fileSize, spatialReference));
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      if (finish()) reject(new Error(event.message || 'LandXML worker failed'));
    };
    const transferable = typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer);
    if (!isCurrent()) {
      if (finish()) reject(new Error('LandXML parsing cancelled'));
      return;
    }
    worker.postMessage(buffer, transferable ? [buffer] : []);
  });
}
