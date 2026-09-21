/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import { buildLandXmlSurfaceComponents, parseLandXmlGeometry, type LandXmlGeometryPayload, type LandXmlGeometryPreflight, type LandXmlSourceBuffer, type LandXmlStreamedComponent, type LandXmlTinDocument } from './landXmlIngest.js';
import { parseLandXmlSourceWithApi, readLandXmlTinSurface } from './landXmlWasm.js';
import { streamLandXmlSourceBlobWithApi } from './landXmlBlobCursor.js';
import { placeComponentsInKnownRenderFrame } from './landXmlRenderFrame.js';
import { spatialMetadataFromLandXml, spatialReferenceFromSourceMetadata } from './sourceSpatialReference.js';
import { LandXmlStreamPreflightReducer } from './landXmlStreamPreflight.js';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<LandXmlSourceBuffer | LandXmlBlobWorkerRequest | LandXmlWorkerContinue>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

interface LandXmlBlobWorkerRequest {
  file: Blob;
  streamFederatedPreflight?: boolean;
}

interface LandXmlWorkerContinue { type: 'preflight-approved' | 'component-uploaded' | 'source-event-processed' }

function isContinue(value: unknown): value is LandXmlWorkerContinue {
  return typeof value === 'object' && value !== null && (
    (value as { type?: unknown }).type === 'preflight-approved'
    || (value as { type?: unknown }).type === 'component-uploaded'
    || (value as { type?: unknown }).type === 'source-event-processed'
  );
}

let approvePreflight: (() => void) | null = null;
let acknowledgeComponent: (() => void) | null = null;
let acknowledgeSourceEvent: (() => void) | null = null;

function waitForPreflightApproval(preflight: LandXmlGeometryPreflight, emit = true): Promise<void> {
  return new Promise((resolve) => {
    approvePreflight = resolve;
    if (emit) workerScope.postMessage({ preflight });
  });
}

function waitForComponentUpload(component: LandXmlStreamedComponent): Promise<void> {
  return new Promise((resolve) => {
    acknowledgeComponent = resolve;
    const mesh = component.mesh;
    workerScope.postMessage({ component }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer]);
  });
}

function waitForSourceEvent(event: unknown): Promise<void> {
  return new Promise((resolve) => {
    acknowledgeSourceEvent = resolve;
    workerScope.postMessage({ sourceEvent: event });
  });
}

function waitForPreflightComponent(mesh: import('@ifc-lite/geometry').MeshData): Promise<void> {
  return new Promise((resolve) => {
    acknowledgeComponent = resolve;
    workerScope.postMessage({ preflightComponent: mesh }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer]);
  });
}

function streamUnits(header: unknown): NonNullable<LandXmlTinDocument['units']> {
  if (typeof header !== 'object' || header === null) throw new Error('LandXML stream emitted an invalid header');
  const units = (header as { units?: unknown }).units;
  if (typeof units !== 'object' || units === null) throw new Error('LandXML stream header omitted Units');
  const raw = units as {
    linear_unit?: unknown;
    elevation_unit?: unknown;
    linear_scale_to_meters?: unknown;
    elevation_scale_to_meters?: unknown;
  };
  if (typeof raw.linear_unit !== 'string' || typeof raw.elevation_unit !== 'string') {
    throw new Error('LandXML stream header has invalid unit names');
  }
  if (typeof raw.linear_scale_to_meters !== 'number' || !Number.isFinite(raw.linear_scale_to_meters)
    || typeof raw.elevation_scale_to_meters !== 'number' || !Number.isFinite(raw.elevation_scale_to_meters)) {
    throw new Error('LandXML stream header has invalid unit scales');
  }
  return {
    linearUnit: raw.linear_unit,
    elevationUnit: raw.elevation_unit,
    linearScaleToMeters: raw.linear_scale_to_meters,
    elevationScaleToMeters: raw.elevation_scale_to_meters,
  };
}

function isBlobRequest(value: unknown): value is LandXmlBlobWorkerRequest {
  return typeof value === 'object' && value !== null && 'file' in value && (value as { file?: unknown }).file instanceof Blob;
}

function surfaceComponent(component: ReturnType<typeof buildLandXmlSurfaceComponents>['components'][number]): LandXmlStreamedComponent {
  return {
    mesh: component.mesh,
    surfaceName: component.surfaceName,
    surfaceSourceId: component.surfaceSourceId,
    pipeSourceId: component.pipeSourceId,
    renderedFaceSourceIds: component.renderedFaceSourceIds,
  };
}

workerScope.onmessage = async (event: MessageEvent<LandXmlSourceBuffer | LandXmlBlobWorkerRequest | LandXmlWorkerContinue>): Promise<void> => {
  const input = event.data;
  if (isContinue(input)) {
    if (input.type === 'preflight-approved') {
      approvePreflight?.();
      approvePreflight = null;
    } else if (input.type === 'component-uploaded') {
      acknowledgeComponent?.();
      acknowledgeComponent = null;
    } else {
      acknowledgeSourceEvent?.();
      acknowledgeSourceEvent = null;
    }
    return;
  }
  try {
    // A worker owns a separate WASM instance. Pass the original bytes directly:
    // ArrayBuffers are transferred by the client and SharedArrayBuffers remain shared.
    await init();
    const api = new IfcAPI();
    let payload: LandXmlGeometryPayload | null = null;
    let streamed: { preflight: LandXmlGeometryPreflight } | null = null;
    try {
      const document = isBlobRequest(input)
        ? await (async () => {
          // Pass one derives the exact component envelope and canonical
          // dominant frame while releasing every mesh immediately. Pass two
          // rebuilds the source against that frozen policy; a mismatch is a
          // hard failure, never a partially publishable model.
          const reducer = new LandXmlStreamPreflightReducer();
          await streamLandXmlSourceBlobWithApi(api, input.file, {
            onProgress: (loadedBytes, totalBytes) => workerScope.postMessage({ progress: { loadedBytes, totalBytes: totalBytes * 2 } }),
            onHeader: (header) => reducer.onHeader(header),
            onSurface: (surface) => reducer.onSurface(surface),
            onEvent: (streamEvent) => reducer.onEvent(streamEvent),
          });
          const reduced = reducer.finish();
          const preflight = reduced.preflight;
          workerScope.postMessage({
            preflight,
            sourceCoordinateInfo: reduced.sourceCoordinateInfo,
            spatialReference: (() => {
              const metadata = spatialMetadataFromLandXml({ coordinateSystem: reduced.coordinateSystem });
              return metadata.horizontalId && metadata.verticalId
                ? spatialReferenceFromSourceMetadata(metadata)
                : undefined;
            })(),
          });
          await waitForPreflightApproval(preflight, false);
          if (input.streamFederatedPreflight) {
            let emitted = 0;
            const federatedReducer = new LandXmlStreamPreflightReducer(async (mesh) => {
              mesh.expressId = ++emitted;
              await waitForPreflightComponent(mesh);
            });
            await streamLandXmlSourceBlobWithApi(api, input.file, {
              onHeader: (header) => federatedReducer.onHeader(header),
              onSurface: (surface) => federatedReducer.onSurface(surface),
              onEvent: (streamEvent) => federatedReducer.onEvent(streamEvent),
            });
            if (federatedReducer.finish().preflight.componentCount !== preflight.componentCount || emitted !== preflight.componentCount) {
              throw new Error('LandXML federation preflight did not reproduce its component envelope');
            }
            workerScope.postMessage({ preflightComplete: true });
            await new Promise<void>((resolve) => { approvePreflight = resolve; });
          }
          let units: NonNullable<LandXmlTinDocument['units']> | null = null;
          let nextLocalId = 1;
          await streamLandXmlSourceBlobWithApi(api, input.file, {
            onProgress: (loadedBytes, totalBytes) => workerScope.postMessage({ progress: { loadedBytes: totalBytes + loadedBytes, totalBytes: totalBytes * 2 } }),
            onHeader: (header) => { units = streamUnits(header); },
            onSurface: async (surface) => {
              if (units === null) throw new Error('LandXML surface arrived before stream Units');
              const built = buildLandXmlSurfaceComponents(readLandXmlTinSurface(surface), units, nextLocalId);
              if (input.streamFederatedPreflight) {
                for (const component of built.components) {
                  component.mesh.expressId = nextLocalId++;
                  await waitForComponentUpload(surfaceComponent(component));
                }
              } else {
                const placed = placeComponentsInKnownRenderFrame(built.components, preflight.frame ?? { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false }, []);
                for (const component of placed.placed) {
                  component.mesh.expressId = nextLocalId++;
                  await waitForComponentUpload(surfaceComponent(component));
                }
              }
            },
            onEvent: waitForSourceEvent,
          });
          return { kind: 'blob' as const, preflight };
        })()
        // TODO(remove-by: #5050 completion, owner: LandXML)
        // Buffer callers are retained only for the test/legacy compatibility
        // adapter; the canonical loadFile LandXML path sends a Blob request.
        : { kind: 'buffer' as const, document: parseLandXmlSourceWithApi(api, input) };
      if (document.kind === 'blob') streamed = document;
      else payload = parseLandXmlGeometry(document.document);
    } finally {
      api.free();
    }
    if (streamed !== null) {
      // Components were transferred and acknowledged one at a time. The
      // terminal message is semantic-only: never rebuild and retransmit every
      // positions/normals/indices buffer as a complete payload.
      workerScope.postMessage({ ok: true, streamed });
    } else if (payload !== null) {
      const transfer: Transferable[] = [];
      for (const mesh of payload.geometryResult.meshes) {
        transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer);
      }
      workerScope.postMessage({ ok: true, payload } satisfies { ok: true; payload: LandXmlGeometryPayload }, transfer);
    } else {
      throw new Error('LandXML worker completed without a result');
    }
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
