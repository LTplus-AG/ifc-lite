/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared LandXML component placement and stable local-ID assignment. */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { createCoordinateInfo, type Bounds3D } from '../../utils/localParsingUtils.js';
import {
  MAX_RENDER_FRAME_LOCAL_EXTENT_METRES, placeComponentsInKnownRenderFrame,
  placeComponentsInRenderFrame, type LandXmlRenderFramePlan,
} from './landXmlRenderFrame.js';

export interface LandXmlGeometryComponent {
  mesh: MeshData;
  bounds: Bounds3D;
  /** RTE batches from one source surface are admitted or refused together. */
  frameGroup?: string;
  surfaceName: string;
  surfaceSourceId: string | null;
  pipeSourceId: string | null;
  renderedFaceSourceIds: string[];
}

export interface PlacedLandXmlComponents {
  components: LandXmlGeometryComponent[];
  dropped: LandXmlGeometryComponent[];
  geometry: GeometryResult;
}

/**
 * The one owner of local component identities. Both direct completion and a
 * provisional stream transaction must call this after choosing their shared
 * render frame, so an entity never gets a different local id by load mode.
 */
export function placeAndAssignLandXmlComponents(
  components: LandXmlGeometryComponent[],
  warnings: string[],
  frame?: LandXmlRenderFramePlan,
): PlacedLandXmlComponents {
  const { placed, dropped, bounds, originShift, hasLargeCoordinates } = frame
    ? placeComponentsInKnownRenderFrame(components, frame, warnings)
    : placeComponentsInRenderFrame(components, warnings);
  if (placed.length === 0) {
    throw new Error(`LandXML document has no surface components within the ${MAX_RENDER_FRAME_LOCAL_EXTENT_METRES / 1000} km shared render-frame envelope`);
  }
  const meshes = placed.map((component, index) => ({ ...component.mesh, expressId: index + 1 }));
  const totals = meshes.reduce((total, mesh) => ({
    totalVertices: total.totalVertices + mesh.positions.length / 3,
    totalTriangles: total.totalTriangles + mesh.indices.length / 3,
  }), { totalVertices: 0, totalTriangles: 0 });
  return {
    components: placed,
    dropped,
    geometry: {
      meshes,
      totalVertices: totals.totalVertices,
      totalTriangles: totals.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds, originShift, hasLargeCoordinates),
    },
  };
}
