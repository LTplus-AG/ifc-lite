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
  if (!renderer) throw new Error('Renderer not initialised for LandXML provisional publication');
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
  return new LandXmlProvisionalTransaction(modelId, preflight.componentCount, preflight.frame, federationRegistry, resources());
}

export function openFederatedLandXmlStreamingPlan(
  modelId: string,
  preflight: LandXmlGeometryPreflight,
  sourceCoordinateInfo: CoordinateInfo,
  spatialReference: ModelSpatialReference | undefined,
  isCurrent: () => boolean,
): FederatedLandXmlStreamingPlan | null {
  if (preflight.componentCount === 0) return null;
  return new FederatedLandXmlStreamingPlan({
    modelId,
    componentCount: preflight.componentCount,
    sourceCoordinateInfo,
    spatialReference,
    registry: federationRegistry,
    resources: resources(),
    isCurrent,
  });
}
