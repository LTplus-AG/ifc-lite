/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared entity World-Coordinate math (IFC Z-up, project space — NOT
 * map/WGS84). Single source of truth for both the Properties panel's
 * coordinate readout and the Lists "World X/Y/Z" columns (issue #3671), so
 * the two features can never disagree about what "World Coordinate" means
 * for the same element.
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

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let found = false;

  for (const mesh of geoResult.meshes) {
    if (mesh.expressId !== targetExpressId) continue;
    found = true;
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

  if (!found) return null;

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
  return (expressId) => {
    const centerZup = computeEntityWorldCenterZup(geoResult, toGlobalId(expressId), frame);
    if (!centerZup) return null;
    if (!(lengthScale > 0)) return centerZup; // defensive: never divide by 0/NaN
    return { x: centerZup.x / lengthScale, y: centerZup.y / lengthScale, z: centerZup.z / lengthScale };
  };
}
