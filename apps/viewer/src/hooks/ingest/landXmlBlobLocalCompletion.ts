/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Main-realm terminal assembly for the shared bounded LandXML cursor passes. */

import { IfcAPI } from '@ifc-lite/wasm';
import type { CoordinateInfo, MeshData, ModelSpatialReference } from '@ifc-lite/geometry';
import {
  buildLandXmlStreamedPipeComponents, completeLandXmlStreamedGeometry, type LandXmlGeometryPayload,
  type LandXmlGeometryPreflight, type LandXmlStreamedComponent, type LandXmlStreamedSkippedComponent,
  type LandXmlStreamedSurfaceDiagnostics,
} from './landXmlIngest.js';
import { streamLandXmlBlobWithSink } from './landXmlBlobStreamDriver.js';
import { LandXmlStreamDocumentAssembler, type LandXmlAssembledSourceDocument } from './landXmlStreamAssembler.js';
import type { LandXmlPreflightComponent } from './landXmlStreamPreflight.js';
import { readLandXmlSourceDocument } from './landXmlWasm.js';
import { initLandXmlWasm } from './landXmlWasmInit.js';

export interface LandXmlBlobLocalCallbacks {
  onProgress?(loadedBytes: number, totalBytes: number): void;
  onPreflight?(preflight: LandXmlGeometryPreflight): void | Promise<void>;
  onComponent?(mesh: MeshData): void | Promise<void>;
  onFederatedPreflight?(
    preflight: LandXmlGeometryPreflight,
    sourceCoordinateInfo: CoordinateInfo,
    spatialReference?: ModelSpatialReference,
  ): boolean | Promise<boolean>;
  onPreflightComponent?(component: LandXmlPreflightComponent): void | Promise<void>;
  onPreflightComplete?(): void | Promise<void>;
  onFederatedAdmissionComponent?(component: LandXmlPreflightComponent): void | Promise<void>;
  onFederatedAdmissionComplete?(): void | Promise<void>;
  onSkippedComponent?(component: LandXmlStreamedSkippedComponent): void | Promise<void>;
}

const LOCAL_CALLBACK_CANCELLATION_POLL_MS = 25;

function ensureCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Error('LandXML parsing cancelled');
}

/** Race an externally-owned callback against liveness without leaking a late rejection. */
async function awaitWhileCurrent<T>(isCurrent: () => boolean, callback: () => T | Promise<T>): Promise<T> {
  ensureCurrent(isCurrent);
  const callbackResult = Promise.resolve().then(callback);
  let cancellationPoll: ReturnType<typeof setInterval> | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancellationPoll = setInterval(() => {
      if (!isCurrent()) reject(new Error('LandXML parsing cancelled'));
    }, LOCAL_CALLBACK_CANCELLATION_POLL_MS);
  });
  try {
    const value = await Promise.race([callbackResult, cancelled]);
    ensureCurrent(isCurrent);
    return value;
  } finally {
    if (cancellationPoll !== undefined) clearInterval(cancellationPoll);
    // A held callback may reject after cancellation won the race. Attach a
    // handler now so its late outcome cannot become an unhandled rejection.
    void callbackResult.catch(() => undefined);
  }
}

/**
 * The worker-less host executes the same four cursor passes and awaited sink
 * fences as a Worker. It retains only the terminal semantic source document;
 * primary/federated GPU consumers still receive raw slots one at a time.
 */
export async function parseLandXmlBlobInCurrentRealm(
  file: Blob,
  isCurrent: () => boolean,
  callbacks: LandXmlBlobLocalCallbacks,
): Promise<LandXmlGeometryPayload> {
  ensureCurrent(isCurrent);
  await initLandXmlWasm();
  ensureCurrent(isCurrent);
  const api = new IfcAPI();
  const sourceAssembler = new LandXmlStreamDocumentAssembler();
  const streamedComponents: LandXmlStreamedComponent[] = [];
  const streamedSkippedComponents: LandXmlStreamedSkippedComponent[] = [];
  const streamedSurfaceDiagnostics = new Map<string, LandXmlStreamedSurfaceDiagnostics>();
  let streamedSource: LandXmlAssembledSourceDocument | null = null;
  let consumedComponentCount = 0;
  try {
    const streamed = await streamLandXmlBlobWithSink(api, file, {
      onProgress: callbacks.onProgress,
      onPreflight: (preflight, sourceCoordinateInfo, spatialReference) => awaitWhileCurrent(isCurrent, async () => {
        await callbacks.onPreflight?.(preflight);
        ensureCurrent(isCurrent);
        return (await callbacks.onFederatedPreflight?.(preflight, sourceCoordinateInfo, spatialReference)) === true;
      }),
      onPreflightComponent: (component) => awaitWhileCurrent(
        isCurrent, () => callbacks.onPreflightComponent?.(component),
      ),
      onPreflightComplete: () => awaitWhileCurrent(isCurrent, () => callbacks.onPreflightComplete?.()),
      onFederatedAdmissionComponent: (component) => awaitWhileCurrent(
        isCurrent, () => callbacks.onFederatedAdmissionComponent?.(component),
      ),
      onFederatedAdmissionComplete: () => awaitWhileCurrent(isCurrent, () => callbacks.onFederatedAdmissionComplete?.()),
      onComponent: (component) => awaitWhileCurrent(isCurrent, async () => {
        await callbacks.onComponent?.(component.mesh);
        ensureCurrent(isCurrent);
        streamedComponents.push(component);
        consumedComponentCount++;
      }),
      onSkippedComponent: (component) => awaitWhileCurrent(isCurrent, async () => {
        await callbacks.onSkippedComponent?.(component);
        ensureCurrent(isCurrent);
        streamedSkippedComponents.push(component);
        consumedComponentCount++;
      }),
      onSurfaceDiagnostics: (diagnostics) => {
        if (streamedSurfaceDiagnostics.has(diagnostics.surfaceSourceId)) {
          throw new Error('LandXML cursor emitted duplicate surface diagnostics');
        }
        streamedSurfaceDiagnostics.set(diagnostics.surfaceSourceId, diagnostics);
      },
      onSourceEvent: (event) => {
        const completed = sourceAssembler.push(event).document;
        if (completed === null) return;
        if (streamedSource !== null) throw new Error('LandXML cursor emitted multiple completed source documents');
        streamedSource = completed;
      },
    }, { isCurrent, wantsFederatedStreaming: callbacks.onFederatedPreflight !== undefined });
    ensureCurrent(isCurrent);
    if (streamedSource === null) throw new Error('LandXML cursor ended without a credited source document');
    const parsed = readLandXmlSourceDocument(streamedSource);
    const pipeComponents = buildLandXmlStreamedPipeComponents(
      parsed, consumedComponentCount + 1, streamed.preflight, !streamed.federatedStreaming,
    );
    for (const slot of pipeComponents.slots) {
      ensureCurrent(isCurrent);
      if ('component' in slot) {
        await awaitWhileCurrent(isCurrent, () => callbacks.onComponent?.(slot.component.mesh));
        streamedComponents.push(slot.component);
      } else {
        await awaitWhileCurrent(isCurrent, () => callbacks.onSkippedComponent?.(slot.skipped));
        streamedSkippedComponents.push(slot.skipped);
      }
      consumedComponentCount++;
    }
    ensureCurrent(isCurrent);
    if (consumedComponentCount !== streamed.preflight.componentCount) {
      throw new Error('LandXML second pass did not reproduce its preflight component envelope');
    }
    if (streamed.preflight.componentCount > 0 && streamedComponents.length === 0) {
      throw new Error('LandXML preflight rejected every render component');
    }
    return completeLandXmlStreamedGeometry(
      parsed, streamedComponents, streamed.preflight, streamedSurfaceDiagnostics,
      streamedSkippedComponents, pipeComponents.warnings,
      streamed.droppedPrimaryComponents + pipeComponents.droppedComponentCount,
    );
  } finally {
    sourceAssembler.abort();
    api.free();
  }
}
