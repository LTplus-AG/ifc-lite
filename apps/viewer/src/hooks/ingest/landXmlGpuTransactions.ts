/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Renderer-backed transaction factories shared by primary and federation loads. */

import type { CoordinateInfo, ModelSpatialReference } from '@ifc-lite/geometry';
import type { LandXmlDeclaredCrs } from './landXmlRenderFrame.js';
import type { LandXmlGeorefAssumptions } from './landXmlGeorefAssumptions.js';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '../useBCF.js';
import type { LandXmlGeometryPreflight } from './landXmlIngest.js';
import { FederatedLandXmlStreamingPlan } from './federatedLandXmlStreaming.js';
import { LandXmlProvisionalTransaction, type LandXmlFederationReservation } from './landXmlProvisionalTransaction.js';

/**
 * A provisional GPU upload failed. Distinct from the invariant errors
 * `LandXmlProvisionalTransaction.publish` raises (preflight ID envelope,
 * component ordering) — those are programming errors and must stay fatal,
 * while this one is environmental (an exhausted, lost, or software-emulated
 * device) and the load can complete without the provisional fast path (#5175).
 */
export class LandXmlProvisionalUploadError extends Error {
  constructor(reason: string) {
    super(`LandXML provisional GPU upload failed: ${reason}`);
    this.name = 'LandXmlProvisionalUploadError';
  }
}

function resources() {
  const renderer = getGlobalRenderer();
  // `isReady()` matters as much as existence (#5175). The renderer instance is
  // created before `init()` resolves, so a LandXML file dropped in the first
  // moments after page load reached `addMeshes` on an uninitialized device and
  // threw "Renderer not initialized. Call init() first." — which failed the
  // ENTIRE load, not just the provisional fast path. Declining the provisional
  // here lets the normal publish happen once the device is up.
  if (!renderer || !renderer.isReady()) return null;
  return {
    publish: (mesh: import('@ifc-lite/geometry').MeshData) => {
      const outcome = renderer.addMeshes([mesh], true);
      if (!outcome.ok) throw new LandXmlProvisionalUploadError(outcome.reason);
    },
    remove: (globalExpressIds: readonly number[]) => { renderer.getScene().removeMeshesForEntities(globalExpressIds); },
  };
}

const landXmlRegistry: LandXmlFederationReservation = {
  reserveModel(modelId, maxExpressId) {
    const view = useViewerStore.getState().getMutationView(modelId);
    const firstRetained = view?.getCreatedExpressIdBounds().lowest ?? 0;
    // An overlapping overlay is discarded by final registration, not by a provisional upload.
    if (firstRetained > 0 && firstRetained <= maxExpressId) {
      return federationRegistry.reserveModel(modelId, maxExpressId);
    }
    return federationRegistry.reserveModel(modelId, maxExpressId, firstRetained, view?.peekNextExpressId());
  },
  publishRange: (modelId, start, end) => federationRegistry.publishRange(modelId, start, end),
  unregisterModel: modelId => federationRegistry.unregisterModel(modelId),
};

export function openPrimaryLandXmlProvisional(
  modelId: string,
  preflight: LandXmlGeometryPreflight,
): LandXmlProvisionalTransaction | null {
  if (preflight.componentCount === 0 || preflight.frame === null) return null;
  const rendererResources = resources();
  if (rendererResources === null) return null;
  return new LandXmlProvisionalTransaction(modelId, preflight.componentCount, preflight.frame, landXmlRegistry, rendererResources);
}

export function openFederatedLandXmlStreamingPlan(
  modelId: string,
  preflight: LandXmlGeometryPreflight,
  sourceCoordinateInfo: CoordinateInfo,
  spatialReference: ModelSpatialReference | undefined,
  declaredCrs: LandXmlDeclaredCrs | undefined,
  isCurrent: () => boolean,
  /** The assumptions `spatialReference` was built under; absent means none. */
  assumptions?: Partial<LandXmlGeorefAssumptions>,
): FederatedLandXmlStreamingPlan | null {
  if (preflight.componentCount === 0) return null;
  const rendererResources = resources();
  if (rendererResources === null) return null;
  return new FederatedLandXmlStreamingPlan({
    modelId,
    componentCount: preflight.componentCount,
    sourceCoordinateInfo,
    spatialReference,
    declaredCrs,
    assumptions,
    registry: landXmlRegistry,
    resources: rendererResources,
    isCurrent,
  });
}
