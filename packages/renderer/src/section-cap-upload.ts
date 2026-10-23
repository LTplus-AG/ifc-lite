/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a section cap's 2D drawing lands in 3D (`Renderer.uploadSection2DOverlay`),
 * lifted out of `RendererOverlays`: the cardinal drawing is lifted onto an
 * axis-aligned plane at a world coordinate derived from the slider percentage and
 * the SAME range formula the clip plane uses, and a face-picked plane carries its
 * own basis. `planeId` keys the cap of a cutting plane beyond the first (#7545);
 * without it the primary plane's cap is replaced, as it always was.
 */

import { projectedBoundsRange } from './section-plane-resolve.js';
import type { Section2DOverlayRenderer, CutPolygon2D, DrawingLine2D } from './section-2d-overlay.js';
import type { ModelBounds } from './render-section-draw.js';

type CustomPlane = { origin: [number, number, number]; tangent: [number, number, number]; bitangent: [number, number, number] };

/** True when overlay geometry changed (the caller then asks for a frame); false for the early returns that leave it untouched. */
export function uploadSectionCap(
  overlay: Section2DOverlayRenderer,
  modelBounds: ModelBounds | null,
  planeId: string | undefined,
  polygons: CutPolygon2D[],
  lines: DrawingLine2D[],
  axis: 'down' | 'front' | 'side',
  position: number, // 0-100 percentage
  sectionRange: { min?: number; max?: number } | undefined, // Same storey-based range as section plane
  flipped: boolean,
  customPlane?: CustomPlane,
): boolean {
  const upload = (planePosition: number, custom?: CustomPlane): void => (planeId === undefined
    ? overlay.uploadDrawing(polygons, lines, axis, planePosition, flipped, custom)
    : overlay.uploadExtraDrawing(planeId, polygons, lines, axis, planePosition, flipped, custom));

  if (customPlane) {
    // Custom-plane path: planePosition / axis are unused — the
    // basis the cap shader needs travels in `customPlane`. We pass
    // 0 for `planePosition` and the existing `axis` so the cardinal
    // shader code path that callers depend on (e.g. legacy SVG
    // export) keeps working when customPlane is omitted.
    upload(0, customPlane);
    return true;
  }

  // Same range formula as the clip plane (`resolveSectionPlaneFrame`),
  // shared rather than copied — but deliberately evaluated against the
  // UN-ROTATED axis normal, which is what makes the two agree instead of
  // merely look alike (#2447).
  //
  // `planePosition` is not a plane distance here: `transform2Dto3D` lifts
  // the cardinal drawing onto an AXIS-ALIGNED plane at that world
  // coordinate (`side` -> `[planePosition, y, x]`), and the polygons it
  // lifts were cut on that same axis-aligned plane upstream. Feeding it
  // the rotated plane's distance would move the cap off the geometry it
  // was cut from. A rotated or face-picked plane reaches the cap through
  // `customPlane` above, which carries its own basis.
  const axisNormal: [number, number, number] =
    axis === 'side' ? [1, 0, 0] : axis === 'down' ? [0, 1, 0] : [0, 0, 1];

  // Allow upload if either sectionRange has both values, or modelBounds exists as fallback
  const hasFullRange = sectionRange?.min !== undefined && sectionRange?.max !== undefined;
  if (!hasFullRange && !modelBounds) return false;

  const axisRange = modelBounds ? projectedBoundsRange(modelBounds.min, modelBounds.max, axisNormal) : null;
  const minVal = sectionRange?.min ?? axisRange!.min;
  const maxVal = sectionRange?.max ?? axisRange!.max;
  upload(minVal + (position / 100) * (maxVal - minVal));
  return true;
}
