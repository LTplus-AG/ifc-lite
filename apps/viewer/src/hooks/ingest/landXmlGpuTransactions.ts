/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Renderer-backed transaction factories shared by primary and federation loads. */

import type { CoordinateInfo, ModelSpatialReference } from '@ifc-lite/geometry';
import { federationRegistry } from '@ifc-lite/renderer';
import { getGlobalRenderer } from '../useBCF.js';
import type { LandXmlGeometryPreflight } from './landXmlIngest.js';
import { FederatedLandXmlStreamingPlan } from './federatedLandXmlStreaming.js';
import { LandXmlProvisionalTransaction } from './landXmlProvisionalTransaction.js';

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
      if (!outcome.ok) throw new Error(`LandXML provisional GPU upload failed: ${outcome.reason}`);
    },
    remove: (globalExpressIds: readonly number[]) => { renderer.getScene().removeMeshesForEntities(globalExpressIds); },
  };
}

export function openPrimaryLandXmlProvisional(
  modelId: string,
  preflight: LandXmlGeometryPreflight,
): LandXmlProvisionalTransaction | null {
  if (preflight.componentCount === 0 || preflight.frame === null) return null;
  const rendererResources = resources();
  if (rendererResources === null) return null;
  return new LandXmlProvisionalTransaction(modelId, preflight.componentCount, preflight.frame, federationRegistry, rendererResources);
}

export function openFederatedLandXmlStreamingPlan(
  modelId: string,
  preflight: LandXmlGeometryPreflight,
  sourceCoordinateInfo: CoordinateInfo,
  spatialReference: ModelSpatialReference | undefined,
  isCurrent: () => boolean,
): FederatedLandXmlStreamingPlan | null {
  if (preflight.componentCount === 0) return null;
  const rendererResources = resources();
  if (rendererResources === null) return null;
  return new FederatedLandXmlStreamingPlan({
    modelId,
    componentCount: preflight.componentCount,
    sourceCoordinateInfo,
    spatialReference,
    registry: federationRegistry,
    resources: rendererResources,
    isCurrent,
  });
}
