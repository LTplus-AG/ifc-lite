/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 2D → 3D lift and cap geometry building.
 *
 * Pure array maths, no GPU state: "what shape does the drawing have on the
 * plane". `Section2DOverlayRenderer` owns the buffers and calls in here for the
 * vertex data to put in them, which is why nothing in this file touches a
 * `GPUDevice`. Its failure stories are geometric (the cap lands off a tilted
 * plane, a concave cross-section triangulates inside-out, holes are not
 * stitched, a flipped axis is mirrored the wrong way) and are all testable with
 * plain numbers.
 */

import { earClip, joinHoles, type Pt } from './symbolic-overlay-pipelines.js';

/** Semantic cardinal section axis: down (Y), front (Z), side (X). */
export type SectionAxis = 'down' | 'front' | 'side';

/**
 * Arbitrary (face-picked) section plane, issue #243. The same basis is used by
 * `SectionCutter` to project triangle-plane intersections to 2D, so the
 * round-trip through {@link createSectionLift} is exact.
 */
export interface SectionCustomPlane {
  origin: [number, number, number];
  tangent: [number, number, number];
  bitangent: [number, number, number];
}

export interface CutPolygon2D {
  polygon: {
    outer: Array<{ x: number; y: number }>;
    holes: Array<Array<{ x: number; y: number }>>;
  };
  ifcType: string;
  expressId: number;
  /** Optional per-polygon RGBA (0–1). When present, this cap polygon fills with
   *  this colour (an `IfcMaterialLayerSet` wall/slab layer, or a frame+glass
   *  window part) instead of the uniform cap fill. Absent ⇒ uniform cap style +
   *  per-`ifcType` fallback, unchanged. */
  color?: [number, number, number, number];
}

export interface DrawingLine2D {
  line: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  category: string;
  /**
   * Express ID of the entity that authored this segment. Optional — only the
   * IfcAnnotation / IfcGridAxis symbolic overlay sets it (so per-entity hide
   * can drop an annotation's curves without a mesh). The section-cut and
   * drawing-2d cutters leave it undefined.
   */
  ownerId?: number;
}

/** A 2D drawing point lifted onto the section plane in world space. */
export type SectionLift = (x2d: number, y2d: number) => [number, number, number];

/**
 * Transform 2D coordinates to 3D coordinates on the section plane.
 *
 * Cardinal axis path (legacy, unchanged):
 * - Y axis (down): 2D (x, y) = 3D (x, z) - looking down at XZ plane
 * - Z axis (front): 2D (x, y) = 3D (x, y) - looking along Z at XY plane
 * - X axis (side): 2D (x, y) = 3D (z, y) - looking along X at ZY plane
 * When flipped, the 2D x coordinate is negated.
 *
 * Custom-plane path (issue #243): when `customPlane` is supplied, the
 * 3D point is `origin + tangent*x2d + bitangent*y2d`. The same basis
 * is used by `SectionCutter` to project triangle-plane intersections
 * to 2D, so the round-trip is exact and the cap polygons land
 * precisely on the user's tilted plane.
 */
export function transform2Dto3D(
  x2d: number,
  y2d: number,
  axis: SectionAxis,
  planePosition: number,
  flipped: boolean = false,
  customPlane?: SectionCustomPlane,
): [number, number, number] {
  if (customPlane) {
    // Custom plane: bypass the cardinal-axis swap. `flipped` is
    // intentionally ignored because for arbitrary planes the cutter
    // does not mirror its 2D output (mirroring only makes sense for
    // cardinal projections that have a consistent "view direction").
    const o = customPlane.origin;
    const t = customPlane.tangent;
    const b = customPlane.bitangent;
    return [
      o[0] + t[0] * x2d + b[0] * y2d,
      o[1] + t[1] * x2d + b[1] * y2d,
      o[2] + t[2] * x2d + b[2] * y2d,
    ];
  }

  // Handle flipped - the 2D x coordinate was negated during projection
  const x = flipped ? -x2d : x2d;

  switch (axis) {
    case 'down': // Y axis - horizontal cut (floor plan)
      // 2D.x = 3D.x, 2D.y = 3D.z -> 3D (x, planeY, y)
      return [x, planePosition, y2d];
    case 'front': // Z axis - vertical cut (section view)
      // 2D.x = 3D.x, 2D.y = 3D.y -> 3D (x, y, planeZ)
      return [x, y2d, planePosition];
    case 'side': // X axis - vertical cut (side elevation)
      // 2D.x = 3D.z, 2D.y = 3D.y -> 3D (planeX, y, x)
      return [planePosition, y2d, x];
  }
}

/**
 * Bind a lift ONCE per upload rather than re-resolving the axis/custom-plane
 * branch per vertex. `uploadDrawing` runs over every cut polygon on each
 * section-slider commit, so the branch is hoisted out of the inner loop; the
 * returned closure allocates exactly the same one tuple per point that
 * {@link transform2Dto3D} does.
 */
export function createSectionLift(
  axis: SectionAxis,
  planePosition: number,
  flipped: boolean = false,
  customPlane?: SectionCustomPlane,
): SectionLift {
  return (x2d, y2d) => transform2Dto3D(x2d, y2d, axis, planePosition, flipped, customPlane);
}

/** Interleaved `[x, y, z, r, g, b, a]` cap vertices plus their triangle indices. */
export interface CapFillGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * Triangulate the cut polygons and lift them onto the section plane.
 *
 * Hole-aware ear-clipping (reused from the IfcAnnotationFillArea fill path)
 * replaces the old convex fan. The fan ignored holes and inverted on the
 * CONCAVE cross-sections that arbitrary IFC profiles (and material-layer
 * slabs) cut into, leaving the cut face uncovered — it read as a hollow
 * shell. Section 2D points are (x, y); the triangulator works in (x, z),
 * so y maps to z.
 *
 * Returns `null` when nothing survives (no polygon had three usable points),
 * so the caller can skip buffer creation entirely.
 */
export function buildCapFillGeometry(
  polygons: readonly CutPolygon2D[],
  lift: SectionLift,
): CapFillGeometry | null {
  const fillVertices: number[] = [];
  const fillIndices: number[] = [];
  let vertexOffset = 0;

  for (const polygon of polygons) {
    const outer = polygon.polygon.outer;
    if (outer.length < 3) continue;

    // Per-polygon fill colour. A material-layer wall/slab delivers one polygon
    // per layer, each carrying its IfcMaterial RGBA (window frame/glass parts
    // likewise). Polygons WITHOUT a colour use the sentinel alpha −1 so the
    // fill shader falls back to the uniform cap style (architectural fill +
    // hatch) byte-identically — see fs_main.
    const color: [number, number, number, number] = polygon.color ?? [0, 0, 0, -1];

    const outerRing: Pt[] = outer.map((p) => ({ x: p.x, z: p.y }));
    const holeRings: Pt[][] = polygon.polygon.holes
      .filter((h) => h.length >= 3)
      .map((h) => h.map((p) => ({ x: p.x, z: p.y })));
    const stitched = holeRings.length > 0 ? joinHoles(outerRing, holeRings) : outerRing;
    const tris = earClip(stitched);
    if (tris.length === 0) continue;

    const baseVertex = vertexOffset;
    for (const pt of stitched) {
      const [x3d, y3d, z3d] = lift(pt.x, pt.z);
      fillVertices.push(x3d, y3d, z3d, color[0], color[1], color[2], color[3]);
      vertexOffset++;
    }
    for (const [a, b, c] of tris) {
      fillIndices.push(baseVertex + a, baseVertex + b, baseVertex + c);
    }
  }

  if (fillVertices.length === 0) return null;
  return {
    vertices: new Float32Array(fillVertices),
    indices: new Uint32Array(fillIndices),
  };
}

/**
 * Enumerate the cut outline as a line-list: every polygon's outer ring, every
 * hole ring, then the extra drawing lines (hatching etc.), each lifted onto the
 * section plane. Rings close back onto their first point.
 *
 * Returns `null` when there is nothing to draw.
 */
export function buildDrawingOutlineVertices(
  polygons: readonly CutPolygon2D[],
  lines: readonly DrawingLine2D[],
  lift: SectionLift,
): Float32Array | null {
  const lineVertices: number[] = [];

  // Polygon outlines
  for (const polygon of polygons) {
    const outer = polygon.polygon.outer;
    for (let i = 0; i < outer.length; i++) {
      const p1 = outer[i];
      const p2 = outer[(i + 1) % outer.length];
      const [x1, y1, z1] = lift(p1.x, p1.y);
      const [x2, y2, z2] = lift(p2.x, p2.y);
      lineVertices.push(x1, y1, z1, x2, y2, z2);
    }

    // Hole outlines
    for (const hole of polygon.polygon.holes) {
      for (let i = 0; i < hole.length; i++) {
        const p1 = hole[i];
        const p2 = hole[(i + 1) % hole.length];
        const [x1, y1, z1] = lift(p1.x, p1.y);
        const [x2, y2, z2] = lift(p2.x, p2.y);
        lineVertices.push(x1, y1, z1, x2, y2, z2);
      }
    }
  }

  // Additional drawing lines (hatching, etc.)
  for (const line of lines) {
    const [x1, y1, z1] = lift(line.line.start.x, line.line.start.y);
    const [x2, y2, z2] = lift(line.line.end.x, line.line.end.y);
    lineVertices.push(x1, y1, z1, x2, y2, z2);
  }

  if (lineVertices.length === 0) return null;
  return new Float32Array(lineVertices);
}
