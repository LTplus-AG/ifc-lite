/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Snapshot and restore the complete geometry frame that federation alignment rewrites. */

import type { FederatedModel, PreAlignmentSnapshot } from '../../store/index.js';
import { growPreAlignment } from '../../store/slices/data-mesh-prealign.js';

type AlignableGeometry = NonNullable<FederatedModel['geometryResult']>;

/** Capture a geometry result's current state as its independently owned baseline. */
export function capturePreAlignment(geometry: AlignableGeometry): PreAlignmentSnapshot {
  // `coordinateInfo` is nested; a shallow copy would let an in-place frame
  // update rewrite the baseline and make the next restore a no-op.
  return growPreAlignment(
    {
      positions: [],
      normals: [],
      origins: [],
      geometryAabbs: [],
      coordinateInfo: structuredClone(geometry.coordinateInfo),
      // Alignment replaces boxes instead of editing them, so the box objects
      // themselves are safe to retain while the map owns its entry set.
      instancedGeometryAabbs: geometry.instancedGeometryAabbs
        ? new Map(geometry.instancedGeometryAabbs)
        : undefined,
    },
    geometry.meshes,
  );
}

/** Restore exactly the channels {@link capturePreAlignment} snapshots. */
export function restorePreAlignment(
  geometry: AlignableGeometry,
  snapshot: PreAlignmentSnapshot,
): void {
  const meshes = geometry.meshes;
  const restoreCount = Math.min(meshes.length, snapshot.positions.length);
  for (let i = 0; i < restoreCount; i += 1) {
    meshes[i].positions = new Float32Array(snapshot.positions[i]);
    const normals = snapshot.normals[i];
    if (normals) meshes[i].normals = new Float32Array(normals);
    const origin = snapshot.origins[i];
    if (origin) meshes[i].origin = [...origin];
    else delete meshes[i].origin;
    const box = snapshot.geometryAabbs[i];
    if (box) meshes[i].geometryAabb = box;
    else delete meshes[i].geometryAabb;
  }
  geometry.coordinateInfo = structuredClone(snapshot.coordinateInfo);
  geometry.instancedGeometryAabbs = snapshot.instancedGeometryAabbs
    ? new Map(snapshot.instancedGeometryAabbs)
    : undefined;
}
