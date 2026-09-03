/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared entity World-Coordinate math (IFC Z-up, project space — NOT
 * map/WGS84), backing the Lists "World X/Y/Z" columns (issue #3671).
 *
 * NOT yet the single source of truth: `PropertiesPanel.tsx` still holds its own
 * copy of the same bounding-box loop, and the two do not even agree numerically
 * — the panel renders metres while this reports project units, so a millimetre
 * model shows World Z `3.5` in the panel and `3500` in the list. The list column
 * is unit-labelled and the panel readout is not. Folding the panel onto this
 * module is the point of having it here and has not been done.
 *
 * What this computes is the CENTRE of an entity's world bounding box, not its
 * composed `IfcLocalPlacement` origin. `MeshData.localToWorld` carries the
 * resolved placement chain and is not used. For an L-shaped slab the centre can
 * sit outside the element, and it is not the number other IFC tools report as
 * the object placement.
 *
 * The frame reconstruction itself (RTC offset + origin shift, axis
 * conversion) already has one shared implementation —
 * `resolveRenderFrame`/`useRenderFrameOffsets` and `renderToWorldViewer`/
 * `viewerToIfcAxes` in `measure-modes/coordinates.ts`, which the Properties
 * panel and the Measure tool's picked-point readout both route through. This
 * module does not re-derive that: it only adds the piece those don't cover —
 * finding an ENTITY's local-frame bounding-box center from its meshes — then
 * hands the result through the existing frame functions.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { Point3 } from '@/components/viewer/tools/measure-modes/components';
import { renderToWorldViewer, viewerToIfcAxes, type RenderFrameOffsets } from '@/components/viewer/tools/measure-modes/coordinates';
import { getIfcLengthUnitScale } from './effective-georef.js';

export type Vec3 = Point3;

/**
 * Bounding-box CENTER of `targetExpressId`'s meshes in `geoResult`, in the
 * render (local scene, Y-up) frame — the frame `scene.getEntityBoundingBox`
 * and `renderToWorldViewer` both work in. Returns `null` when the geometry
 * result has no meshes matching `targetExpressId` (not decoded / not yet
 * loaded / element has no geometry) — callers MUST treat this as
 * "unavailable", not as the origin.
 */
export function computeEntityLocalCenter(
  geoResult: GeometryResult | null | undefined,
  targetExpressId: number,
): Vec3 | null {
  if (!geoResult?.meshes?.length) return null;
  return centerOfMeshes(geoResult.meshes.filter((m) => m.expressId === targetExpressId));
}

/** Bounding-box centre of an already-selected mesh list, in the render frame.
 *  Split out so the Lists getter can index once and hand over the matching
 *  meshes instead of rescanning every mesh in the model per cell. */
export function centerOfMeshes(meshes: readonly GeometryResult['meshes'][number][]): Vec3 | null {
  if (meshes.length === 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const mesh of meshes) {
    const pos = mesh.positions;
    const o = mesh.origin;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i] + ox, y = pos[i + 1] + oy, z = pos[i + 2] + oz;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  // Every matching mesh could still carry zero vertices (bounded-geometry mode
  // releases `positions` in place), which would leave the extents at +/-Infinity
  // and return NaN on all three axes. A NaN cell is not merely blank: the list
  // comparator does `a - b`, so it makes the sort inconsistent and scrambles the
  // whole table, and `gt`/`lt` silently drop those rows.
  if (minX === Infinity) return null;

  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

/**
 * World Coordinate (IFC Z-up, project space) of `targetExpressId`'s
 * bounding-box center: the local-frame center with `frame`'s render-frame
 * shift (RTC offset + origin shift, see `renderToWorldViewer`) added back,
 * then converted from renderer (Y-up) to IFC (Z-up) axes. `null` when the
 * element has no matching mesh in `geoResult` (not decoded yet, or has no
 * geometry) — never a misleading fallback to the origin.
 */
export function computeEntityWorldCenterZup(
  geoResult: GeometryResult | null | undefined,
  targetExpressId: number,
  frame: RenderFrameOffsets,
): Vec3 | null {
  const localCenter = computeEntityLocalCenter(geoResult, targetExpressId);
  if (!localCenter) return null;
  const worldCenterYup = renderToWorldViewer(localCenter, frame);
  return viewerToIfcAxes(worldCenterYup);
}

/**
 * Build the Lists `getWorldPosition` accessor for one model (issue #3671):
 * resolves the entity's World Coordinate through the shared scene-wide
 * render frame, then converts the geometry pipeline's SI metres back into
 * the model's own declared length unit — the shared per-column unit
 * resolver (routed to via the `QuantityType.Length` tag) expects a raw cell
 * already in the model's own unit, exactly like a real `IfcQuantityLength`.
 * `toGlobalId` maps a local express id to `geoResult.meshes`' id space.
 */
export function makeWorldPositionGetter(
  store: IfcDataStore,
  geoResult: GeometryResult | null | undefined,
  frame: RenderFrameOffsets,
  toGlobalId: (expressId: number) => number,
): (expressId: number) => Vec3 | null {
  const lengthScale = getIfcLengthUnitScale(store);

  // Index once, not per cell. `computeEntityLocalCenter` scans EVERY mesh in the
  // model to find one entity's, and a list asks per row per axis: 100k rows with
  // World X/Y/Z is 300k scans of a 100k-mesh array. Measured at 0.114 ms/call,
  // that is ~34 s inside the requestAnimationFrame callback that builds the
  // list, with the tab frozen and no progress shown. A geometry CONDITION is
  // worse still, because `resolveSourceSet` filters the full candidate set.
  const byId = new Map<number, GeometryResult['meshes'][number][]>();
  for (const mesh of geoResult?.meshes ?? []) {
    const bucket = byId.get(mesh.expressId);
    if (bucket) bucket.push(mesh);
    else byId.set(mesh.expressId, [mesh]);
  }

  // The INDEX is cached; the computed centre deliberately is not. Moving an
  // element through the gizmo or the numeric position editor mutates
  // `MeshData.positions` IN PLACE, leaving `geometryResult` and `models` at the
  // same identities the provider memo keys on, so the memo does not rebuild and
  // a cached centre would keep reporting the pre-move coordinate. The index
  // survives that safely because it holds the same MeshData objects, whose
  // contents the mutation updates; only a cached VALUE would go stale.
  //
  // Recomputing costs the vertices of one entity, not a scan of every mesh in
  // the model, which is where the original cost was: 0.114 ms/call before,
  // 0.0013 ms/call with the index and no value cache.
  return (expressId) => {
    const local = centerOfMeshes(byId.get(toGlobalId(expressId)) ?? []);
    if (!local) return null;
    const zup = viewerToIfcAxes(renderToWorldViewer(local, frame));
    if (!(lengthScale > 0)) return zup; // defensive: never divide by 0/NaN
    return { x: zup.x / lengthScale, y: zup.y / lengthScale, z: zup.z / lengthScale };
  };
}
