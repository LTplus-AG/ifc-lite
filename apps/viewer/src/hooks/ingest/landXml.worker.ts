/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import {
  parseLandXmlGeometry, type LandXmlGeometryPayload, type LandXmlGeometryPreflight,
  type LandXmlSourceBuffer, type LandXmlStreamedComponent,
} from './landXmlIngest.js';
import { streamLandXmlBlobWithSink } from './landXmlBlobStreamDriver.js';
import { parseLandXmlSourceWithApi } from './landXmlWasm.js';
import type { LandXmlPreflightComponent } from './landXmlStreamPreflight.js';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<LandXmlSourceBuffer | LandXmlBlobWorkerRequest | LandXmlWorkerContinue>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

interface LandXmlBlobWorkerRequest {
  file: Blob;
  streamFederatedPreflight?: boolean;
  /** #5175: retry value the viewer supplies after a units refusal. */
  assumedLinearUnit?: string;
}

interface LandXmlWorkerContinue {
  type: 'preflight-approved' | 'component-uploaded' | 'source-event-processed';
  federatedStreaming?: boolean;
}

function isContinue(value: unknown): value is LandXmlWorkerContinue {
  return typeof value === 'object' && value !== null
    && ((value as { federatedStreaming?: unknown }).federatedStreaming === undefined
      || typeof (value as { federatedStreaming?: unknown }).federatedStreaming === 'boolean') && (
    (value as { type?: unknown }).type === 'preflight-approved'
    || (value as { type?: unknown }).type === 'component-uploaded'
    || (value as { type?: unknown }).type === 'source-event-processed'
  );
}

function isBlobRequest(value: unknown): value is LandXmlBlobWorkerRequest {
  return typeof value === 'object' && value !== null && 'file' in value && (value as { file?: unknown }).file instanceof Blob;
}

let approvePreflight: ((federatedStreaming: boolean) => void) | null = null;
let acknowledgeComponent: (() => void) | null = null;
let acknowledgeSourceEvent: (() => void) | null = null;

function awaitPreflightApproval(): Promise<boolean> {
  return new Promise((resolve) => { approvePreflight = resolve; });
}

function awaitComponent(message: unknown, transfer?: Transferable[]): Promise<void> {
  return new Promise((resolve) => {
    acknowledgeComponent = resolve;
    workerScope.postMessage(message, transfer);
  });
}

function awaitSourceEvent(event: unknown): Promise<void> {
  return new Promise((resolve) => {
    acknowledgeSourceEvent = resolve;
    workerScope.postMessage({ sourceEvent: event });
  });
}

function meshTransfer(component: { mesh: LandXmlStreamedComponent['mesh'] | LandXmlPreflightComponent['mesh'] }): Transferable[] {
  const { mesh } = component;
  return [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer] as Transferable[];
}

async function streamBlobRequest(api: IfcAPI, input: LandXmlBlobWorkerRequest): Promise<{
  preflight: LandXmlGeometryPreflight;
  droppedPrimaryComponents: number;
}> {
  const result = await streamLandXmlBlobWithSink(api, input.file, {
    onProgress: (loadedBytes, totalBytes) => workerScope.postMessage({ progress: { loadedBytes, totalBytes } }),
    onPreflight: async (preflight, sourceCoordinateInfo, spatialReference) => {
      workerScope.postMessage({ preflight, sourceCoordinateInfo, spatialReference });
      return awaitPreflightApproval();
    },
    onPreflightComponent: (component) => awaitComponent({ preflightComponent: component }, meshTransfer(component)),
    onPreflightComplete: async () => {
      workerScope.postMessage({ preflightComplete: true });
      await awaitPreflightApproval();
    },
    onFederatedAdmissionComponent: (component) => awaitComponent({ federatedAdmissionComponent: component }, meshTransfer(component)),
    onFederatedAdmissionComplete: async () => {
      workerScope.postMessage({ federatedAdmissionComplete: true });
      await awaitPreflightApproval();
    },
    onComponent: (component) => awaitComponent({ component }, meshTransfer(component)),
    onSkippedComponent: (skippedComponent) => awaitComponent({ skippedComponent }),
    onSurfaceDiagnostics: (surfaceDiagnostics) => awaitComponent({ surfaceDiagnostics }),
    onSourceEvent: awaitSourceEvent,
  }, { wantsFederatedStreaming: input.streamFederatedPreflight === true, assumedLinearUnit: input.assumedLinearUnit });
  return { preflight: result.preflight, droppedPrimaryComponents: result.droppedPrimaryComponents };
}

workerScope.onmessage = async (event: MessageEvent<LandXmlSourceBuffer | LandXmlBlobWorkerRequest | LandXmlWorkerContinue>): Promise<void> => {
  const input = event.data;
  if (isContinue(input)) {
    if (input.type === 'preflight-approved') {
      approvePreflight?.(input.federatedStreaming === true);
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
    await init();
    const api = new IfcAPI();
    try {
      if (isBlobRequest(input)) {
        const streamed = await streamBlobRequest(api, input);
        workerScope.postMessage({ ok: true, streamed });
        return;
      }
      const payload: LandXmlGeometryPayload = parseLandXmlGeometry(parseLandXmlSourceWithApi(api, input));
      const transfer: Transferable[] = [];
      for (const mesh of payload.geometryResult.meshes) {
        transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer);
      }
      workerScope.postMessage({ ok: true, payload } satisfies { ok: true; payload: LandXmlGeometryPayload }, transfer);
    } finally {
      api.free();
    }
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
