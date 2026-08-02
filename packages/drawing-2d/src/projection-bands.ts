/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Projection bands — classify geometry that lies *beyond* the section cut
 * into the two architectural floor-plan reference bands (issue #979):
 *
 *  - **VISIBLE** (toward the floor, the side a down-looking plan keeps):
 *    drawn as a **thin solid** projected edge.
 *  - **OVERHEAD** (above the cut — beams, soffits, roofs, eaves):
 *    drawn **dashed** (mapped to `visibility: 'hidden'` downstream so the
 *    existing hidden-line styling applies with no renderer change).
 *
 * # Sign convention (locked — matches the rest of the pipeline)
 * Given a world coordinate `coord` along the cut axis and the plane
 * `position`, the signed, *flip-adjusted* depth is
 *
 *   `d = flipped ? -(coord - position) : (coord - position)`
 *
 * which is exactly `depthAlong` (profile-projector) / the
 * `HiddenLineClassifier` depth-buffer convention, and the mirror of the
 * annotation-cull half-space test in `useDrawingGeneration`.
 * With `d`:
 *
 *   - `d < 0` ⇒ BELOW the cut (toward the floor, nearer the viewer) ⇒ VISIBLE
 *   - `d > 0` ⇒ ABOVE the cut (overhead, farther from the viewer)  ⇒ OVERHEAD
 *
 * `flipped` only mirrors which half-space is "below"; it never re-derives a
 * flipped plane normal (the cutter keeps the unflipped normal — see
 * `section-cutter.ts`), so band math applies the flip sign itself.
 *
 * All depths are in the same metric, RTC-shifted world space the section
 * cutter and `MeshData.positions` use (WASM applies `unit_scale` upstream).
 */

import type { SectionPlaneConfig, Vec3, DrawingLine, MeshOutline2D } from './types.js';
import { projectTo2D, projectTo2DBasis } from './math.js';
import type { Point2D } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Classification of geometry relative to the two projection bands. */
export type ProjectionBand =
  | 'visible'   // below the cut → thin solid
  | 'overhead'  // above the cut → dashed
  | 'spanning'  // straddles the cut (drawn solid; the cut line itself is separate)
  | 'cull';     // outside both bands → drop

/** Depth window beyond the cut, per side, in world units. Both > 0. */
export interface ProjectionBandDepths {
  /** How far below the cut (toward the floor) to project as VISIBLE/solid. */
  below: number;
  /** How far above the cut (overhead) to project as OVERHEAD/dashed. */
  above: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// AXIS HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** The canonical (unflipped) +axis unit normal for a cardinal section axis. */
function cardinalNormal(axis: 'x' | 'y' | 'z'): Vec3 {
  switch (axis) {
    case 'x':
      return { x: 1, y: 0, z: 0 };
    case 'y':
      return { x: 0, y: 1, z: 0 };
    case 'z':
      return { x: 0, y: 0, z: 1 };
  }
}

/**
 * The unit normal + plane offset used to measure depth. For a custom
 * (face-picked) plane the cutter uses `normal`/`distance` verbatim, so reuse
 * them; for cardinal axes the normal is the +axis unit and the offset is the
 * plane `position`.
 */
function planeNormalDistance(plane: SectionPlaneConfig): { normal: Vec3; offset: number } {
  if (plane.customPlane) {
    return { normal: plane.customPlane.normal, offset: plane.customPlane.distance };
  }
  return { normal: cardinalNormal(plane.axis), offset: plane.position };
}

/**
 * Flip-adjusted depth of a raw coordinate along the cut axis — the scalar
 * mirror of {@link signedDepth} for callers that only have an axis coordinate
 * (e.g. an element's `axisMin`/`axisMax`) rather than a full 3D point. Keeps
 * the `flipped ? -raw : raw` sign convention in a single place.
 */
export function signedAxisDepth(coord: number, position: number, flipped: boolean): number {
  const raw = coord - position;
  return flipped ? -raw : raw;
}

/**
 * Flip-adjusted signed depth of a world point from the cut plane.
 * `d < 0` ⇒ below (visible side); `d > 0` ⇒ above (overhead side).
 */
export function signedDepth(point: Vec3, plane: SectionPlaneConfig): number {
  const { normal, offset } = planeNormalDistance(plane);
  const raw = point.x * normal.x + point.y * normal.y + point.z * normal.z - offset;
  return plane.flipped ? -raw : raw;
}

/**
 * The camera viewing direction (unit, pointing away from the viewer into the
 * scene) for silhouette detection. For a cardinal axis it is the −axis (or
 * +axis when flipped); for a custom plane it follows the plane normal.
 */
export function getViewDirectionForPlane(plane: SectionPlaneConfig): Vec3 {
  const sign = plane.flipped ? 1 : -1;
  if (plane.customPlane) {
    const n = plane.customPlane.normal;
    return { x: n.x * sign, y: n.y * sign, z: n.z * sign };
  }
  switch (plane.axis) {
    case 'x':
      return { x: sign, y: 0, z: 0 };
    case 'y':
      return { x: 0, y: sign, z: 0 };
    case 'z':
      return { x: 0, y: 0, z: sign };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECTION (2D) — single entry point matching the section cutter
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project a world point into the drawing's 2D space using the SAME basis the
 * section cutter uses, so projected construction lines coincide exactly with
 * the cut polygons. Cardinal axes → `projectTo2D`; custom plane → the
 * tangent/bitangent basis (`projectTo2DBasis`).
 */
export function projectPointForPlane(point: Vec3, plane: SectionPlaneConfig): Point2D {
  if (plane.customPlane) {
    const c = plane.customPlane;
    return projectTo2DBasis(point, c.origin, c.tangent, c.bitangent);
  }
  return projectTo2D(point, plane.axis, plane.flipped);
}

// ═══════════════════════════════════════════════════════════════════════════
// BAND CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify a flip-adjusted depth *range* `[dMin, dMax]` into a projection band.
 *
 * - VISIBLE band occupies `[-below, 0)` (below the cut, toward the floor).
 * - OVERHEAD band occupies `(0, +above]` (above the cut, overhead).
 *
 * An element overlapping both (e.g. a wall cut at mid-height) is `'spanning'`
 * and drawn solid — its footprint is real near-floor geometry; the cut line
 * itself is emitted separately by the section cutter.
 */
export function classifyDepthRange(
  dMin: number,
  dMax: number,
  depths: ProjectionBandDepths,
): ProjectionBand {
  // Guard against caller passing them swapped.
  const lo = Math.min(dMin, dMax);
  const hi = Math.max(dMin, dMax);

  const visibleOverlap = lo < 0 && hi >= -depths.below;
  const overheadOverlap = hi > 0 && lo <= depths.above;

  if (visibleOverlap && overheadOverlap) return 'spanning';
  if (visibleOverlap) return 'visible';
  if (overheadOverlap) return 'overhead';
  return 'cull';
}

/**
 * Classify a single world-space line segment by its endpoints' depths.
 * Used by the silhouette/edge fallback where each edge is classified on its
 * own (no extrusion range).
 */
export function classifySegmentBand(
  a: Vec3,
  b: Vec3,
  plane: SectionPlaneConfig,
  depths: ProjectionBandDepths,
): ProjectionBand {
  const da = signedDepth(a, plane);
  const db = signedDepth(b, plane);
  return classifyDepthRange(da, db, depths);
}

/**
 * Map a band to the `DrawingLine.visibility` the renderer keys off:
 * overhead → `'hidden'` (dashed), everything kept → `'visible'` (solid).
 * Returns `null` for `'cull'` so the caller drops the line.
 */
export function bandVisibility(band: ProjectionBand): 'visible' | 'hidden' | null {
  switch (band) {
    case 'overhead':
      return 'hidden';
    case 'visible':
    case 'spanning':
      return 'visible';
    case 'cull':
      return null;
  }
}

/**
 * Convert a winding-robust mesh footprint outline (from the Rust
 * `meshOutline2d` binding) into band-classified construction-projection lines
 * (issue #979). The whole element is classified by its axis extent
 * (`axisMin`/`axisMax`) — below the cut → solid, above → dashed. Contours are
 * already in drawing 2D space, so they're emitted as closed loops verbatim.
 *
 * This is the winding-robust alternative to the normal-based silhouette path:
 * it draws the true projected footprint even when the source mesh is wound
 * inconsistently (common for ifc-lite roofs/stairs/site).
 */
export function outlineToProjectionLines(
  outline: MeshOutline2D,
  meta: { entityId: number; ifcType: string; modelIndex: number },
  plane: SectionPlaneConfig,
  depths: ProjectionBandDepths,
): DrawingLine[] {
  // The outline path is cardinal-only (the toggle is gated off for custom
  // planes), so classify against the cardinal plane position.
  const pos = plane.customPlane ? plane.customPlane.distance : plane.position;
  const dMin = signedAxisDepth(outline.axisMin, pos, plane.flipped);
  const dMax = signedAxisDepth(outline.axisMax, pos, plane.flipped);
  const visibility = bandVisibility(classifyDepthRange(dMin, dMax, depths));
  if (visibility === null) return [];

  const lines: DrawingLine[] = [];
  for (const ring of outline.contours) {
    const n = Math.floor(ring.length / 2);
    if (n < 3) continue; // a closed ring needs ≥3 vertices (matches the Rust source)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n; // close the loop (last → first)
      const sx = ring[i * 2];
      const sy = ring[i * 2 + 1];
      const ex = ring[j * 2];
      const ey = ring[j * 2 + 1];
      if (Math.abs(sx - ex) < 1e-7 && Math.abs(sy - ey) < 1e-7) continue;
      lines.push({
        line: { start: { x: sx, y: sy }, end: { x: ex, y: ey } },
        category: 'projection',
        visibility,
        entityId: meta.entityId,
        ifcType: meta.ifcType,
        modelIndex: meta.modelIndex,
        depth: 0,
      });
    }
  }
  return lines;
}
