/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSyntheticDataStore, type IfcDataStore } from '@ifc-lite/parser';
import type { LandXmlGeometryPayload, LandXmlGeometryPreflight, LandXmlSourceBuffer, LandXmlStreamedComponent, LandXmlStreamedSkippedComponent, LandXmlStreamedSurfaceDiagnostics } from './landXmlIngest.js';
import { buildLandXmlStreamedPipeComponents, completeLandXmlStreamedGeometry, parseLandXmlGeometry, preflightLandXmlGeometry } from './landXmlIngest.js';
import { parseLandXmlSourceInCurrentRealm, readLandXmlSourceDocument } from './landXmlWasm.js';
import { parseLandXmlSourceBlobWithApi } from './landXmlBlobCursor.js';
import { LandXmlStreamDocumentAssembler, type LandXmlAssembledSourceDocument } from './landXmlStreamAssembler.js';
import { initLandXmlWasm } from './landXmlWasmInit.js';
import { IfcAPI } from '@ifc-lite/wasm';
import { spatialMetadataFromLandXml, spatialReferenceFromSourceMetadata } from './sourceSpatialReference.js';
import type { CoordinateInfo, ModelSpatialReference, MeshData } from '@ifc-lite/geometry';
import type { LandXmlPreflightComponent } from './landXmlStreamPreflight.js';

export interface LandXmlViewerModel extends LandXmlGeometryPayload {
  dataStore: IfcDataStore;
  spatialReference?: ModelSpatialReference;
}

/** Convert either callback form to a rejection without letting a synchronous
 * throw escape a worker message handler and strand its outer load promise. */
function invokeCallback<T>(callback: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(callback());
  } catch (error) {
    return Promise.reject(error);
  }
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
  onPreflight?: (preflight: LandXmlGeometryPreflight) => void | Promise<void>,
  onComponent?: (mesh: MeshData) => void | Promise<void>,
  onFederatedPreflight?: (preflight: LandXmlGeometryPreflight, sourceCoordinateInfo: CoordinateInfo, spatialReference?: ModelSpatialReference) => boolean | Promise<boolean>,
  onPreflightComponent?: (component: LandXmlPreflightComponent) => void | Promise<void>,
  onPreflightComplete?: () => void | Promise<void>,
  onFederatedAdmissionComponent?: (component: LandXmlPreflightComponent) => void | Promise<void>,
  onFederatedAdmissionComplete?: () => void | Promise<void>,
  onSkippedComponent?: (component: LandXmlStreamedSkippedComponent) => void | Promise<void>,
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
        await onPreflight?.(preflight);
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
    const streamedComponents: LandXmlStreamedComponent[] = [];
    const streamedSkippedComponents: LandXmlStreamedSkippedComponent[] = [];
    const streamedSurfaceDiagnostics = new Map<string, LandXmlStreamedSurfaceDiagnostics>();
    let federatedStreaming = false;
    let consumedComponentCount = 0;
    const sourceAssembler = new LandXmlStreamDocumentAssembler();
    let streamedSource: LandXmlAssembledSourceDocument | null = null;
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
      | { ok: true; streamed: { preflight: LandXmlGeometryPreflight } }
      | { ok: false; error: string }
      | { progress: { loadedBytes: number; totalBytes: number } }
      | { preflight: LandXmlGeometryPreflight; sourceCoordinateInfo?: CoordinateInfo; spatialReference?: ModelSpatialReference }
      | { preflightComponent: LandXmlPreflightComponent }
      | { preflightComplete: true }
      | { federatedAdmissionComponent: LandXmlPreflightComponent }
      | { federatedAdmissionComplete: true }
      | { component: LandXmlStreamedComponent }
      | { skippedComponent: LandXmlStreamedSkippedComponent }
      | { surfaceDiagnostics: LandXmlStreamedSurfaceDiagnostics }
      | { sourceEvent: unknown }
    >) => {
      if ('progress' in event.data) {
        onProgress?.(event.data.progress.loadedBytes, event.data.progress.totalBytes);
        return;
      }
      if ('preflight' in event.data) {
        const { preflight, sourceCoordinateInfo, spatialReference } = event.data;
        const federatedPreflight = (): boolean | Promise<boolean> => {
          if (onFederatedPreflight === undefined) return false;
          if (sourceCoordinateInfo === undefined) {
            throw new Error('LandXML worker omitted federation source coordinates');
          }
          return onFederatedPreflight(preflight, sourceCoordinateInfo, spatialReference);
        };
        // `Promise.resolve(cb())` evaluates `cb` first, so use the guarded
        // helper to turn a synchronous renderer/reservation failure into the
        // same rejection path as an asynchronous callback failure.
        invokeCallback(() => onPreflight?.(preflight)).then(() => invokeCallback(federatedPreflight)).then((approved) => {
          federatedStreaming = approved === true;
          if (!finished) worker.postMessage({ type: 'preflight-approved', federatedStreaming });
        }).catch((error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if ('preflightComponent' in event.data) {
        const { preflightComponent } = event.data;
        invokeCallback(() => onPreflightComponent?.(preflightComponent)).then(() => {
          if (!finished) worker.postMessage({ type: 'component-uploaded' });
        }).catch((error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if ('preflightComplete' in event.data) {
        invokeCallback(() => onPreflightComplete?.()).then(() => {
          if (!finished) worker.postMessage({ type: 'preflight-approved' });
        }).catch((error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if ('federatedAdmissionComponent' in event.data) {
        const { federatedAdmissionComponent } = event.data;
        invokeCallback(() => onFederatedAdmissionComponent?.(federatedAdmissionComponent)).then(() => {
          if (!finished) worker.postMessage({ type: 'component-uploaded' });
        }).catch((error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if ('federatedAdmissionComplete' in event.data) {
        invokeCallback(() => onFederatedAdmissionComplete?.()).then(() => {
          if (!finished) worker.postMessage({ type: 'preflight-approved' });
        }).catch((error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if ('component' in event.data) {
        const { component } = event.data;
        // Own the transferred typed arrays exactly once. Terminal completion
        // reuses these meshes rather than asking the worker to send a full
        // geometry payload after every component was already acknowledged.
        streamedComponents.push(component);
        consumedComponentCount++;
        invokeCallback(() => onComponent?.(component.mesh)).then(() => {
          if (!finished) worker.postMessage({ type: 'component-uploaded' });
        }).catch((error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if ('skippedComponent' in event.data) {
        const { skippedComponent } = event.data;
        if (!Number.isInteger(skippedComponent.expressId) || skippedComponent.expressId < 1) {
          if (finish()) reject(new Error('LandXML worker emitted an invalid skipped component slot'));
          return;
        }
        consumedComponentCount++;
        streamedSkippedComponents.push(skippedComponent);
        invokeCallback(() => onSkippedComponent?.(skippedComponent)).then(() => {
          if (!finished) worker.postMessage({ type: 'component-uploaded' });
        }).catch((error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if ('surfaceDiagnostics' in event.data) {
        const { surfaceDiagnostics } = event.data;
        if (streamedSurfaceDiagnostics.has(surfaceDiagnostics.surfaceSourceId)) {
          if (finish()) reject(new Error('LandXML worker emitted duplicate surface diagnostics'));
          return;
        }
        streamedSurfaceDiagnostics.set(surfaceDiagnostics.surfaceSourceId, surfaceDiagnostics);
        if (!finished) worker.postMessage({ type: 'component-uploaded' });
        return;
      }
      if ('sourceEvent' in event.data) {
        try {
          const completed = sourceAssembler.push(event.data.sourceEvent).document;
          if (completed !== null) {
            if (streamedSource !== null) throw new Error('LandXML worker emitted multiple completed source documents');
            streamedSource = completed;
          }
          if (!finished) worker.postMessage({ type: 'source-event-processed' });
        } catch (error) {
          sourceAssembler.abort();
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (!finish()) return;
      if (event.data.ok && 'streamed' in event.data) {
        try {
          const streamed = event.data.streamed;
          if (streamedSource === null) throw new Error('LandXML worker ended without a credited source document');
          const parsed = readLandXmlSourceDocument(streamedSource);
          sourceAssembler.abort();
          const pipeComponents = buildLandXmlStreamedPipeComponents(
            parsed,
            consumedComponentCount + 1,
            streamed.preflight,
            !federatedStreaming,
          );
          const publishPipes = async (): Promise<void> => {
            for (const slot of pipeComponents.slots) {
              if (!isCurrent()) throw new Error('LandXML parsing cancelled');
              if ('component' in slot) await invokeCallback(() => onComponent?.(slot.component.mesh));
              else await invokeCallback(() => onSkippedComponent?.(slot.skipped));
              if (!isCurrent()) throw new Error('LandXML parsing cancelled');
              if ('component' in slot) streamedComponents.push(slot.component);
              consumedComponentCount++;
            }
          };
          publishPipes().then(() => {
            if (consumedComponentCount !== streamed.preflight.componentCount) {
              throw new Error('LandXML second pass did not reproduce its preflight component envelope');
            }
            if (streamed.preflight.componentCount > 0 && streamedComponents.length === 0) {
              throw new Error('LandXML preflight rejected every render component');
            }
            resolve(attachSyntheticStore(
              completeLandXmlStreamedGeometry(
                parsed,
                streamedComponents,
                streamed.preflight,
                streamedSurfaceDiagnostics,
                streamedSkippedComponents,
              ),
              file.size,
            ));
          }).catch((error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (event.data.ok) resolve(attachSyntheticStore(event.data.payload, file.size));
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
    worker.postMessage({ file, streamFederatedPreflight: onFederatedPreflight !== undefined });
  });
}
