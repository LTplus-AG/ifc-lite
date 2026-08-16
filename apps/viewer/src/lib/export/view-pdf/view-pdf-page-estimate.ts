/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The page size the to-scale 3D-view PDF export will need, computed BEFORE any
 * line work exists (#2042).
 *
 * DEFECT CLASS — a dialog that offers a scale it cannot print. The page is
 * sized to the drawing, never fitted to a sheet (see `pdf-scale.ts`), so 1:10
 * on a site model asks for metres of paper and blows past PDF's 5080 mm user-
 * space limit; past that a writer either clamps — mis-scaling the one thing the
 * export exists to get right — or emits a page a reader refuses. The user has
 * to learn that BEFORE waiting through a generate, which means the readout
 * cannot depend on the generator's output.
 *
 * So this projects the eight corners of the visible geometry's world AABB
 * through the SAME camera basis the export uses (`buildCameraSectionPlane` +
 * `projectPointForPlane`) and lays them out with the SAME
 * `computePdfScaleLayout`. That makes the estimate an exact UPPER BOUND on the
 * real page: the drawing's own 2D bounds are the extent of geometry inside that
 * box, so they can only be smaller, and a section cut only removes geometry.
 * Callers must present it as an estimate and report the real page size after
 * the export — an estimate quietly labelled as fact is its own defect.
 *
 * Deliberately synchronous and free of the generator, jsPDF and the store: the
 * dialog recomputes it on every scale keystroke.
 */

import type { MeshData } from '@ifc-lite/geometry';
import {
  buildCameraSectionPlane,
  computePdfScaleLayout,
  projectPointForPlane,
  worldBoundsOfMeshes,
  type Bounds2D,
  type CameraFrame,
  type PdfScaleLayout,
  type Vec3,
  type WorldBounds3D,
} from '@ifc-lite/drawing-2d';

/** Default blank paper around the drawing, in mm on every side. */
export const VIEW_PDF_MARGIN_MM = 10;

/**
 * Upper-bound page layout for `meshes` seen from `camera` at 1:`scaleFactor`.
 *
 * Returns `null` when there is nothing to draw (no mesh contributes a finite
 * vertex). Throws only what `buildCameraSectionPlane` and
 * `computePdfScaleLayout` throw — a degenerate camera (eye == target) or an
 * unusable scale — which the dialog surfaces as an error instead of a page.
 */
export function estimateViewPdfLayout(
  meshes: readonly MeshData[],
  camera: CameraFrame,
  scaleFactor: number,
  marginMm: number = VIEW_PDF_MARGIN_MM,
): PdfScaleLayout | null {
  const worldBounds = worldBoundsOfMeshes(meshes);
  if (!worldBounds) return null;
  return computePdfScaleLayout(projectedBounds2D(worldBounds, camera), scaleFactor, marginMm);
}

/**
 * The 2D extent an AABB occupies in the camera's drawing plane.
 *
 * Exported so the dialog can report the drawing's real-world width and height
 * without re-deriving the basis; the projection goes through
 * `projectPointForPlane`, the same helper every line producer in the pipeline
 * uses, so the readout cannot describe a different frame from the print.
 */
export function projectedBounds2D(worldBounds: WorldBounds3D, camera: CameraFrame): Bounds2D {
  const { plane } = buildCameraSectionPlane(camera, worldBounds);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of aabbCorners(worldBounds)) {
    const p = projectPointForPlane(corner, plane);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function aabbCorners(bounds: WorldBounds3D): Vec3[] {
  const corners: Vec3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corners.push({ x, y, z });
      }
    }
  }
  return corners;
}
