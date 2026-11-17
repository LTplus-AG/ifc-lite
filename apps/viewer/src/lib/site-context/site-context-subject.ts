/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The model's own building, described so the core can find it among the
 * swissBUILDINGS3D neighbours (`subject` of `buildSiteContext`): its EGID
 * when the model states one, else its footprint in map coordinates.
 *
 * The footprint is the plan rectangle of the model's actual building
 * geometry, in the model's own axes: the bounds of every product mesh except
 * the ones that are not the building (the site slab, spaces, grids,
 * annotations, openings, geographic elements), its four corners taken
 * through the model's georeference. A rotated model therefore gives a
 * rotated rectangle. It is cheap (one pass over the vertices) and much
 * closer than element placements, which miss everything but the origins.
 */

import { localViewerToProjected, type MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import type { ModelSpatialPlacement } from '@/hooks/ingest/federationAlign';

/** Types whose meshes are not the building's own envelope. */
const NOT_THE_BUILDING = new Set([
  'IfcSite', 'IfcSpace', 'IfcGrid', 'IfcAnnotation', 'IfcOpeningElement', 'IfcGeographicElement', 'IfcVirtualElement',
]);
/** Property names that carry the Swiss federal building identifier. */
const EGID_PROPERTY = /^(egid|gwr_?egid|egid_?gwr)$/i;

/** The EGID an `IfcBuilding` of the model states in any property set, as a string of digits. */
export function modelEgid(dataStore: IfcDataStore | null | undefined): string | undefined {
  if (!dataStore) return undefined;
  for (const building of dataStore.getEntitiesByType('IfcBuilding')) {
    for (const set of dataStore.properties.getForEntity(building.expressId)) {
      for (const property of set.properties) {
        if (!EGID_PROPERTY.test(property.name)) continue;
        const value = String(property.value ?? '').trim();
        if (/^\d+$/.test(value)) return value;
      }
    }
  }
  return undefined;
}

/** Plan bounds (viewer x and z) of the building's own meshes, or `null` when there are none. */
export function buildingPlanBounds(meshes: readonly MeshData[]): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    if (mesh.ifcType && NOT_THE_BUILDING.has(mesh.ifcType)) continue;
    const [ox, , oz] = mesh.origin ?? [0, 0, 0];
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = ox + p[i], z = oz + p[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return minX < maxX && minZ < maxZ ? { minX, maxX, minZ, maxZ } : null;
}

/**
 * The building's footprint as one ring in the frame's projected CRS (easting,
 * northing), corners in order. Heights are irrelevant to the match.
 */
export function modelFootprint(model: FederatedModel, frame: ModelSpatialPlacement): Array<[number, number]> | null {
  const bounds = buildingPlanBounds(model.geometryResult?.meshes ?? []);
  if (!bounds) return null;
  const offset = totalYupOffset(frame.coordinateInfo);
  const corners: Array<[number, number]> = [];
  for (const [x, z] of [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]] as const) {
    const projected = localViewerToProjected(frame.spatialReference, [x, 0, z], offset);
    if (!projected) return null;
    corners.push([projected[0], projected[1]]);
  }
  return corners;
}
