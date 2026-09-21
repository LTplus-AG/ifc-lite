/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSyntheticDataStore, type IfcDataStore } from '@ifc-lite/parser';
import type { LandXmlGeometryPayload, LandXmlSourceBuffer } from './landXmlIngest.js';
import { parseLandXmlGeometry, preflightLandXmlGeometry } from './landXmlIngest.js';
import { parseLandXmlSourceInCurrentRealm } from './landXmlWasm.js';
import { parseLandXmlSourceBlobWithApi } from './landXmlBlobCursor.js';
import { initLandXmlWasm } from './landXmlWasmInit.js';
import { IfcAPI } from '@ifc-lite/wasm';
import { spatialMetadataFromLandXml, spatialReferenceFromSourceMetadata } from './sourceSpatialReference.js';
import type { ModelSpatialReference } from '@ifc-lite/geometry';

export interface LandXmlViewerModel extends LandXmlGeometryPayload {
  dataStore: IfcDataStore;
  spatialReference?: ModelSpatialReference;
}

function attachSyntheticStore(
  payload: LandXmlGeometryPayload,
  fileSize: number,
): LandXmlViewerModel {
  const metadata = spatialMetadataFromLandXml(payload.semanticDocument);
  const spatialReference = metadata.horizontalId && metadata.verticalId
    ? spatialReferenceFromSourceMetadata(metadata)
    : undefined;
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
  if (typeof Worker === 'undefined') {
    if (!isCurrent()) return Promise.reject(new Error('LandXML parsing cancelled'));
    return parseLandXmlSourceInCurrentRealm(buffer).then((parsed) => {
      if (!isCurrent()) throw new Error('LandXML parsing cancelled');
      return attachSyntheticStore(parseLandXmlGeometry(parsed), buffer.byteLength);
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
      | { progress: { loadedBytes: number; totalBytes: number } }
    >) => {
      if ('progress' in event.data) {
        onProgress?.(event.data.progress.loadedBytes, event.data.progress.totalBytes);
        return;
      }
      if (!finish()) return;
      if (event.data.ok) resolve(attachSyntheticStore(event.data.payload, fileSize));
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

/**
 * Canonical File path: structured-clone the Blob to a worker, which feeds
 * bounded slices into the credited WASM stream instead of transferring one
 * whole source ArrayBuffer.
 */
export function parseLandXmlViewerModelFromBlobAsync(
  file: Blob,
  isCurrent: () => boolean = () => true,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<LandXmlViewerModel> {
  if (typeof Worker === 'undefined') {
    if (!isCurrent()) return Promise.reject(new Error('LandXML parsing cancelled'));
    return initLandXmlWasm().then(async () => {
      const api = new IfcAPI();
      try {
        const preflight = preflightLandXmlGeometry(await parseLandXmlSourceBlobWithApi(api, file, {
          isCurrent,
          onProgress: (loadedBytes, totalBytes) => onProgress?.(loadedBytes, totalBytes * 2),
        }));
        const parsed = await parseLandXmlSourceBlobWithApi(api, file, {
          isCurrent,
          onProgress: (loadedBytes, totalBytes) => onProgress?.(totalBytes + loadedBytes, totalBytes * 2),
        });
        return attachSyntheticStore(parseLandXmlGeometry(parsed, preflight), file.size);
      } finally {
        api.free();
      }
    });
  }
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
      if (event.data.ok) resolve(attachSyntheticStore(event.data.payload, file.size));
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      if (finish()) reject(new Error(event.message || 'LandXML worker failed'));
    };
    if (!isCurrent()) {
      if (finish()) reject(new Error('LandXML parsing cancelled'));
      return;
    }
    // Blob structured cloning preserves the backing file handle; it does not
    // transfer or duplicate the full LandXML byte payload.
    worker.postMessage({ file });
  });
}
