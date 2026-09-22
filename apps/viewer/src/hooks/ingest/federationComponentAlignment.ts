/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded one-component adapter over the canonical federation aligner. */

import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { alignGeometryToReference, type FederationAlignmentStatus, type ModelSpatialPlacement } from './federationAlign.js';

export interface AlignedLandXmlComponent {
  mesh: MeshData;
  coordinateInfo: CoordinateInfo;
  status: FederationAlignmentStatus;
}

/**
 * Applies the exact same affine/projection implementation as legacy
 * federation finalization while retaining exactly one component's arrays.
 */
export async function alignLandXmlComponent(
  mesh: MeshData,
  sourceInfo: CoordinateInfo,
  source: ModelSpatialPlacement,
  reference: ModelSpatialPlacement,
): Promise<AlignedLandXmlComponent> {
  const geometry: GeometryResult = {
    meshes: [mesh], totalVertices: mesh.positions.length / 3,
    totalTriangles: mesh.indices.length / 3, coordinateInfo: structuredClone(sourceInfo),
  };
  const status = await alignGeometryToReference(geometry, source, reference);
  return { mesh: geometry.meshes[0]!, coordinateInfo: geometry.coordinateInfo, status };
}
