/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import { buildLandXmlSurfaceComponents, parseLandXmlGeometry, preflightLandXmlGeometry, type LandXmlGeometryPayload, type LandXmlGeometryPreflight, type LandXmlSourceBuffer, type LandXmlTinDocument } from './landXmlIngest.js';
import { parseLandXmlSourceWithApi, readLandXmlTinSurface } from './landXmlWasm.js';
import { parseLandXmlSourceBlobWithApi } from './landXmlBlobCursor.js';
import { placeComponentsInKnownRenderFrame } from './landXmlRenderFrame.js';
import { sourceCoordinateInfo } from './landXmlSourceFrame.js';
import { spatialMetadataFromLandXml, spatialReferenceFromSourceMetadata } from './sourceSpatialReference.js';
import { buildLandXmlPipeComponents } from './landXmlPipeGeometry.js';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<LandXmlSourceBuffer | LandXmlBlobWorkerRequest | LandXmlWorkerContinue>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

interface LandXmlBlobWorkerRequest {
  file: Blob;
  streamFederatedPreflight?: boolean;
}

interface LandXmlWorkerContinue { type: 'preflight-approved' | 'component-uploaded' }

function isContinue(value: unknown): value is LandXmlWorkerContinue {
  return typeof value === 'object' && value !== null && (
    (value as { type?: unknown }).type === 'preflight-approved' || (value as { type?: unknown }).type === 'component-uploaded'
  );
}

let approvePreflight: (() => void) | null = null;
let acknowledgeComponent: (() => void) | null = null;

function waitForPreflightApproval(preflight: LandXmlGeometryPreflight, emit = true): Promise<void> {
  return new Promise((resolve) => {
    approvePreflight = resolve;
    if (emit) workerScope.postMessage({ preflight });
  });
}

function waitForComponentUpload(mesh: import('@ifc-lite/geometry').MeshData): Promise<void> {
  return new Promise((resolve) => {
    acknowledgeComponent = resolve;
    workerScope.postMessage({ component: mesh }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer]);
  });
}

function waitForPreflightComponent(mesh: import('@ifc-lite/geometry').MeshData): Promise<void> {
  return new Promise((resolve) => {
    acknowledgeComponent = resolve;
    workerScope.postMessage({ preflightComponent: mesh }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer]);
  });
}

function streamUnits(header: unknown): { linearScaleToMeters: number; elevationScaleToMeters: number } {
  if (typeof header !== 'object' || header === null) throw new Error('LandXML stream emitted an invalid header');
  const units = (header as { units?: unknown }).units;
  if (typeof units !== 'object' || units === null) throw new Error('LandXML stream header omitted Units');
  const raw = units as { linear_scale_to_meters?: unknown; elevation_scale_to_meters?: unknown };
  if (typeof raw.linear_scale_to_meters !== 'number' || !Number.isFinite(raw.linear_scale_to_meters)
    || typeof raw.elevation_scale_to_meters !== 'number' || !Number.isFinite(raw.elevation_scale_to_meters)) {
    throw new Error('LandXML stream header has invalid unit scales');
  }
  return { linearScaleToMeters: raw.linear_scale_to_meters, elevationScaleToMeters: raw.elevation_scale_to_meters };
}

function isBlobRequest(value: unknown): value is LandXmlBlobWorkerRequest {
  return typeof value === 'object' && value !== null && 'file' in value && (value as { file?: unknown }).file instanceof Blob;
}

async function emitPreflightComponents(document: LandXmlTinDocument): Promise<number> {
  const units = document.units;
  if (units === null) return 0;
  let nextLocalId = 1;
  for (const surface of document.surfaces) {
    if (surface.renderState !== 'rendered' || !surface.faceVisibility.some(Boolean)) continue;
    const built = buildLandXmlSurfaceComponents(surface, units, nextLocalId);
    for (const component of built.components) {
      component.mesh.expressId = nextLocalId++;
      await waitForPreflightComponent(component.mesh);
    }
  }
  const pipes = buildLandXmlPipeComponents(document.pipeNetworks ?? null, nextLocalId);
  for (const component of pipes.components) {
    component.mesh.expressId = nextLocalId++;
    await waitForPreflightComponent(component.mesh);
  }
  return nextLocalId - 1;
}

workerScope.onmessage = async (event: MessageEvent<LandXmlSourceBuffer | LandXmlBlobWorkerRequest | LandXmlWorkerContinue>): Promise<void> => {
  if (isContinue(event.data)) {
    if (event.data.type === 'preflight-approved') {
      approvePreflight?.();
      approvePreflight = null;
    } else {
      acknowledgeComponent?.();
      acknowledgeComponent = null;
    }
    return;
  }
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
          const preflightDocument = await parseLandXmlSourceBlobWithApi(api, event.data.file, {
            onProgress: (loadedBytes, totalBytes) => workerScope.postMessage({ progress: { loadedBytes, totalBytes: totalBytes * 2 } }),
          });
          const preflight = preflightLandXmlGeometry(preflightDocument);
          workerScope.postMessage({
            preflight,
            sourceCoordinateInfo: sourceCoordinateInfo(preflightDocument),
            spatialReference: (() => {
              const metadata = spatialMetadataFromLandXml(preflightDocument);
              return metadata.horizontalId && metadata.verticalId
                ? spatialReferenceFromSourceMetadata(metadata)
                : undefined;
            })(),
          });
          await waitForPreflightApproval(preflight, false);
          if (event.data.streamFederatedPreflight) {
            const emitted = await emitPreflightComponents(preflightDocument);
            if (emitted !== preflight.componentCount) {
              throw new Error('LandXML federation preflight did not reproduce its component envelope');
            }
            workerScope.postMessage({ preflightComplete: true });
            await new Promise<void>((resolve) => { approvePreflight = resolve; });
          }
          let units: { linearScaleToMeters: number; elevationScaleToMeters: number } | null = null;
          let nextLocalId = 1;
          const secondPass = await parseLandXmlSourceBlobWithApi(api, event.data.file, {
            onProgress: (loadedBytes, totalBytes) => workerScope.postMessage({ progress: { loadedBytes: totalBytes + loadedBytes, totalBytes: totalBytes * 2 } }),
            onHeader: (header) => { units = streamUnits(header); },
            onSurface: async (surface) => {
              if (units === null) throw new Error('LandXML surface arrived before stream Units');
              const built = buildLandXmlSurfaceComponents(readLandXmlTinSurface(surface), units, nextLocalId);
              if (event.data.streamFederatedPreflight) {
                for (const component of built.components) {
                  component.mesh.expressId = nextLocalId++;
                  await waitForComponentUpload(component.mesh);
                }
              } else {
                const placed = placeComponentsInKnownRenderFrame(built.components, preflight.frame ?? { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false }, []);
                for (const component of placed.placed) {
                  component.mesh.expressId = nextLocalId++;
                  await waitForComponentUpload(component.mesh);
                }
              }
            },
          });
          if (event.data.streamFederatedPreflight) {
            const pipes = buildLandXmlPipeComponents(secondPass.pipeNetworks ?? null, nextLocalId);
            for (const component of pipes.components) {
              component.mesh.expressId = nextLocalId++;
              await waitForComponentUpload(component.mesh);
            }
            if (nextLocalId - 1 !== preflight.componentCount) {
              throw new Error('LandXML second pass did not reproduce its federation component envelope');
            }
          }
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
