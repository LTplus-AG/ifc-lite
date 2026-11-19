/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section caps and plan cuts over released geometry (#10264). A cut only uses
 * geometry near its plane (plus its projection band), so released meshes are
 * read back for the chunks meeting a slab around the plane, never the whole
 * model. Resident lists run exactly as before, without loading the backing.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import { getViewerState } from '@/store/viewerStoreHandle';
import { meshIsResident } from './geometry-readback';
import type { Slab } from './store-mesh-readback';
import type { Vec3 } from './backing-directory';

const AXES: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** Covers float noise in the cutter's own plane test. */
const EPSILON_METRES = 1e-3;

/** A slab containing the plane and `depth` on either side, in the mesh frame. */
export function cutSlab(plane: Pick<SectionPlaneConfig, 'axis' | 'position' | 'customPlane'>, depth: number): Slab {
  const custom = plane.customPlane;
  const normal: Vec3 = custom ? [custom.normal.x, custom.normal.y, custom.normal.z] : AXES[plane.axis];
  const at = custom ? custom.distance : plane.position;
  const reach = Math.max(0, depth) + EPSILON_METRES;
  return { normal, min: at - reach, max: at + reach };
}

/** Run `cut` over `meshes`, reading released ones back for the slab first. */
export async function withCutGeometry<T>(
  meshes: readonly MeshData[], plane: Pick<SectionPlaneConfig, 'axis' | 'position' | 'customPlane'>, depth: number,
  cut: (meshes: readonly MeshData[]) => Promise<T>,
): Promise<T> {
  if (meshes.every(meshIsResident)) return cut(meshes);
  const [{ activeGeometryBackingTap }, { leaseStoreMeshes }] = await Promise.all([
    import('./backing-debug-hook'), import('./store-mesh-readback')]);
  const models = [...getViewerState().models].map(([modelId, model]) => ({ modelId, meshes: model.geometryResult?.meshes ?? [] }));
  const lease = await leaseStoreMeshes(activeGeometryBackingTap(), models, meshes, { slab: cutSlab(plane, depth) });
  try {
    return await cut(lease.meshes);
  } finally {
    lease.release();
  }
}
