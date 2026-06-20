/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-instanced occurrences are rendered from compact shards and are deliberately
 * absent from `geometryResult.meshes` (the flat consumer set), so one-shot
 * full-geometry exporters (glTF / IFC5) would otherwise drop them. This helper
 * materializes the instanced occurrences from the live renderer scene and appends
 * them to a copy of the geometryResult at export time only (transient — not retained).
 *
 * Instancing applies to the PRIMARY model only (shard entity ids are in the primary
 * model's id space, idOffset 0), so callers pass `isPrimary` and we no-op for
 * federated models.
 */
import { getGlobalRenderer } from '../hooks/useBCF.js';
import type { GeometryResult } from '@ifc-lite/geometry';

export function withInstancedMeshes(
  geometryResult: GeometryResult,
  isPrimary: boolean,
): GeometryResult {
  if (!isPrimary) return geometryResult;
  const scene = getGlobalRenderer()?.getScene();
  const instanced = scene?.getAllInstancedMeshData() ?? [];
  if (instanced.length === 0) return geometryResult;

  let totalTriangles = geometryResult.totalTriangles;
  let totalVertices = geometryResult.totalVertices;
  for (const m of instanced) {
    totalTriangles += m.indices.length / 3;
    totalVertices += m.positions.length / 3;
  }
  return {
    ...geometryResult,
    meshes: [...geometryResult.meshes, ...instanced],
    totalTriangles,
    totalVertices,
  };
}
