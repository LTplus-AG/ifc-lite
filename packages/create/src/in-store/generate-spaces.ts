/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stitch together the auto-space pipeline for a single storey:
 *
 *   walls (existing + overlay)
 *     → 2D axis segments (`extractWallSegmentsForStorey`)
 *     → enclosed regions (`detectEnclosedAreas`)
 *     → IfcSpace per region (`addSpaceToStore` polygon mode)
 *
 * Pure orchestration — the geometry/IFC heavy lifting lives in the
 * dedicated modules. The result lists every IfcSpace expressId emitted
 * plus a richer per-region summary (area, outline) for UI feedback.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import {
  extractWallSegmentsForStorey,
  type OverlayWallReader,
  type WallSkip,
} from './extract-walls.js';
import {
  detectEnclosedAreasWithStats,
  type DetectedSpace,
  type DetectStats,
  type Segment,
  type Vec2,
} from './auto-space-detect.js';
import { addSpaceToStore, type SpaceBuildResult, type SpaceBoundaryInput } from './space.js';

/**
 * IfcSpace.ObjectType marker stamped on every derived space, so a re-run can
 * recognise its own output and skip it instead of duplicating (idempotency),
 * and so generated spaces are filterable downstream.
 */
export const GENERATED_SPACE_OBJECTTYPE = 'IfcLite:GeneratedSpace';

export interface GenerateSpacesOptions {
  /** Snap tolerance for wall-end vertex merge in METRES. Default 0.1 m. */
  snapTolerance?: number;
  /** Drop detected regions below this area in m². Default 0.5 m². */
  minArea?: number;
  /** IfcSpace extrusion height (m). Default 3. */
  height?: number;
  /**
   * Naming pattern for emitted spaces. `{n}` is replaced with a 1-based
   * index. Default `'Space {n}'`.
   */
  namePattern?: string;
  /** Optional IfcSpacePredefinedType (defaults to INTERNAL). */
  predefinedType?: string;
  /** Optional override for IfcSpace.LongName (single value, all spaces). */
  longName?: string;
  /** When true, runs detection but doesn't emit any IfcSpace. */
  dryRun?: boolean;
  /**
   * When true, every stage of the pipeline (wall extraction →
   * detection) emits `console.debug` messages so the viewer's
   * Auto Spaces "no regions detected" failure mode can be diagnosed
   * from devtools without touching the algorithm. The result also
   * carries detection stats unconditionally.
   */
  debug?: boolean;
  /**
   * Additional element types to treat as space dividers (passed to
   * the wall extractor verbatim — case-insensitive). The defaults
   * already cover walls, curtain walls, virtual elements, plates,
   * members, and railings.
   */
  extraDividerTypes?: string[];
  /**
   * Footprint polygons (same metre frame as the detected rooms) of existing
   * spaces on this storey. A detected room whose centroid falls inside one is
   * an overlap with an already-present space and is skipped — so re-running
   * (or filling a partly-spaced floor) doesn't duplicate spaces. Per-space, not
   * per-storey: non-overlapping rooms are still emitted.
   */
  skipFootprints?: Vec2[][];
  /** Where the space boundary sits relative to its walls. Default 'inner'. */
  boundaryMode?: BoundaryMode;
}

export interface GenerateSpacesResult {
  /** Total walls considered (existing + overlay) on the storey. */
  wallsConsidered: number;
  /** Walls that contributed an axis segment to the planar graph. */
  wallsContributing: number;
  /** Walls dropped by the extractor, with the reason (best-effort). */
  wallsSkipped: WallSkip[];
  /** Enclosed regions detected (after min-area + outer-face filter). */
  detected: DetectedSpace[];
  /** Per-stage planar-graph statistics — surfaced for diagnostics. */
  detectionStats: DetectStats;
  /** Per-region builder result. Empty when `dryRun: true`. */
  emitted: Array<{ region: DetectedSpace; result: SpaceBuildResult; name: string }>;
  /** Detected rooms skipped because they overlap an existing space. */
  skippedExisting: number;
}

export function generateSpacesFromWalls(
  editor: StoreEditor,
  store: IfcDataStore,
  storeyExpressId: number,
  options: GenerateSpacesOptions = {},
  overlay?: OverlayWallReader,
): GenerateSpacesResult {
  const height = options.height ?? 3;
  const namePattern = options.namePattern ?? 'Space {n}';
  if (height <= 0) {
    throw new Error('generateSpacesFromWalls: height must be positive');
  }

  const debug = !!options.debug;
  const log = debug ? (...args: unknown[]) => console.debug('[generate-spaces]', ...args) : () => {};
  log(`storey #${storeyExpressId}: starting auto-space generation`);

  const extraction = extractWallSegmentsForStorey(store, storeyExpressId, overlay, {
    debug,
    extraDividerTypes: options.extraDividerTypes,
  });
  log(`extracted ${extraction.segments.length} segments from ${extraction.considered} walls (${extraction.skipped.length} skipped); unitScale=${extraction.lengthUnitScale}`);

  // Snap tolerance / min area are user-friendly metres. Segments are
  // also already converted to metres by the extractor, so no further
  // unit-scaling is needed here.
  const detection = detectEnclosedAreasWithStats(extraction.segments, {
    snapTolerance: options.snapTolerance ?? 0.1,
    minArea: options.minArea ?? 0.5,
    debug,
  });
  const detected = detection.spaces;

  // Always log a one-liner summary at info level so users see something
  // in devtools without flipping the debug flag — the most common
  // failure ("no regions detected") becomes self-explanatory.
  const unitNote = extraction.lengthUnitScale === 1 ? 'metres'
    : extraction.lengthUnitScale === 0.001 ? 'millimetres'
    : `scale ${extraction.lengthUnitScale}`;
  console.info(
    `[auto-spaces] storey #${storeyExpressId}: ${detected.length} region(s) from ${extraction.contributingWallIds.length}/${extraction.considered} walls — ` +
    `${detection.stats.vertices}v / ${detection.stats.segmentsAfterSplit}e / ${detection.stats.faces}f ` +
    `(dropped ${detection.stats.outerFacesDropped} outer + ${detection.stats.belowMinAreaDropped} small) [${unitNote}].`,
  );

  // Per-space dedup: drop detected rooms whose centroid lands inside an
  // existing space footprint, so we don't duplicate already-present spaces
  // (non-overlapping rooms on the same storey are still emitted).
  const skipFootprints = options.skipFootprints ?? [];
  const overlapsExisting = (outline: Vec2[]): boolean => {
    if (skipFootprints.length === 0) return false;
    let cx = 0, cy = 0;
    for (const p of outline) { cx += p[0]; cy += p[1]; }
    cx /= outline.length; cy /= outline.length;
    return skipFootprints.some((fp) => pointInPolygon(cx, cy, fp));
  };
  const rooms = detected.filter((r) => !overlapsExisting(r.outline));
  const skippedExisting = detected.length - rooms.length;

  const emitted: GenerateSpacesResult['emitted'] = [];
  if (options.dryRun || rooms.length === 0) {
    return {
      wallsConsidered: extraction.considered,
      wallsContributing: extraction.contributingWallIds.length,
      wallsSkipped: extraction.skipped,
      detected,
      detectionStats: detection.stats,
      emitted,
      skippedExisting,
    };
  }

  const anchor = resolveSpatialAnchor(store, storeyExpressId);
  if (!anchor) {
    throw new Error(`generateSpacesFromWalls: no resolvable spatial anchor for storey #${storeyExpressId}`);
  }

  const allOutlines = rooms.map((r) => r.outline);
  rooms.forEach((region, i) => {
    const name = namePattern.replace('{n}', String(i + 1));
    const others = allOutlines.filter((_, j) => j !== i);
    // Bake the solid at the inner (net) face — IfcSpace should stop at the room
    // side of the walls, not run to their centreline. GrossFloorArea keeps the
    // centreline measure; NetFloorArea falls out of the inset OuterCurve.
    const netOutline = offsetRoomFootprint(region.outline, extraction.segments, extraction.wallThicknesses, options.boundaryMode ?? 'inner', others);
    const result = addSpaceToStore(editor, anchor, {
      Profile: 'polygon',
      OuterCurve: netOutline,
      Height: height,
      Name: name,
      ObjectType: GENERATED_SPACE_OBJECTTYPE,
      LongName: options.longName,
      PredefinedType: options.predefinedType,
      boundaries: buildSpaceBoundaries(
        region.outline,
        extraction.segments,
        extraction.contributingWallIds,
        others,
      ),
      grossFloorArea: region.area,
    });
    emitted.push({ region, result, name });
  });

  return {
    wallsConsidered: extraction.considered,
    wallsContributing: extraction.contributingWallIds.length,
    wallsSkipped: extraction.skipped,
    detected,
    detectionStats: detection.stats,
    emitted,
    skippedExisting,
  };
}

/** Absolute polygon area (shoelace), m². */
function polygonArea(pts: Vec2[]): number {
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    acc += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(acc) / 2;
}

/** Intersection of two lines given as point + unit direction; null if parallel. */
function lineIntersect(
  p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2,
): Vec2 | null {
  const denom = d0[0] * d1[1] - d0[1] * d1[0];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p1[0] - p0[0]) * d1[1] - (p1[1] - p0[1]) * d1[0]) / denom;
  return [p0[0] + d0[0] * t, p0[1] + d0[1] * t];
}

/** Does outline edge a→b run along wall segment `seg` (parallel, on its
 *  centreline, overlapping extent)? */
function edgeRunsAlong(a: Vec2, b: Vec2, seg: Segment): boolean {
  const PERP_TOL = 0.2, PARALLEL_TOL = 0.03, OVERLAP_MARGIN = 0.3;
  let ex = b[0] - a[0], ey = b[1] - a[1];
  const el = Math.hypot(ex, ey);
  if (el < 1e-6) return false;
  ex /= el; ey /= el;
  let sx = seg.b[0] - seg.a[0], sy = seg.b[1] - seg.a[1];
  const sl = Math.hypot(sx, sy);
  if (sl < 1e-6) return false;
  sx /= sl; sy /= sl;
  if (Math.abs(ex * sy - ey * sx) > PARALLEL_TOL) return false;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const t = (mx - seg.a[0]) * sx + (my - seg.a[1]) * sy;
  const px = seg.a[0] + sx * t, py = seg.a[1] + sy * t;
  if (Math.hypot(mx - px, my - py) > PERP_TOL) return false;
  return t >= -OVERLAP_MARGIN && t <= sl + OVERLAP_MARGIN;
}

/** How a space boundary relates to its bounding walls. */
export type BoundaryMode = 'center' | 'inner' | 'outer';

/** Drop vertices whose two adjacent edges are collinear (e.g. a T-junction
 *  point left on a straight wall run). Such a vertex makes its two adjacent
 *  offset lines parallel, so they don't intersect — the offset then falls back
 *  to the un-offset centreline point and the corner skews. */
function simplifyCollinear(pts: Vec2[]): Vec2[] {
  const n = pts.length;
  if (n < 4) return pts;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    let ax = c[0] - p[0], ay = c[1] - p[1];
    let bx = q[0] - c[0], by = q[1] - c[1];
    const al = Math.hypot(ax, ay) || 1, bl = Math.hypot(bx, by) || 1;
    ax /= al; ay /= al; bx /= bl; by /= bl;
    if (Math.abs(ax * by - ay * bx) > 1e-4) out.push(c); // keep real corners only
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Offset a (centreline) room outline to the chosen wall boundary: `center` =
 * the centreline as-is; `inner` = each edge shifted toward the room by half the
 * wall thickness (net / inner face); `outer` = shifted away by half (gross /
 * outer face). Re-corners by intersecting adjacent offset edges. `segments[k]`
 * has thickness `wallThicknesses[k]`. `otherRooms` (other rooms' centreline
 * outlines) lets `outer` keep shared/internal edges on the centreline so
 * neighbouring rooms meet there instead of overlapping inside the wall.
 * Returns the original outline if the offset degenerates (e.g. an inner inset
 * of a room thinner than its walls). Exact for orthogonal rooms.
 */
export function offsetRoomFootprint(
  outline: Vec2[],
  segments: Segment[],
  wallThicknesses: ReadonlyArray<number | undefined>,
  mode: BoundaryMode = 'inner',
  otherRooms: Vec2[][] = [],
): Vec2[] {
  if (mode === 'center') return outline;
  const simple = simplifyCollinear(outline);
  const n = simple.length;
  if (n < 3) return outline;
  const sign = mode === 'inner' ? 1 : -1; // inner → inward, outer → outward
  const lines: { p: Vec2; d: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = simple[i];
    const b = simple[(i + 1) % n];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return outline;
    dx /= l; dy /= l;
    let half = 0; // half the thickest wall this edge runs along
    for (let k = 0; k < segments.length; k++) {
      const t = wallThicknesses[k];
      if (t !== undefined && t / 2 > half && edgeRunsAlong(a, b, segments[k])) half = t / 2;
    }
    let off = sign * half;
    // A shared (internal) edge has another room on its OUTWARD side. Pushing it
    // outward (outer mode) would overlap that room, so pin shared edges to the
    // centreline; only edges facing outside the building actually push out.
    if (mode === 'outer' && half > 0 && otherRooms.length) {
      const mx = (a[0] + b[0]) / 2 + dy * 0.1; // outward = right normal (dy, -dx)
      const my = (a[1] + b[1]) / 2 - dx * 0.1;
      if (otherRooms.some((poly) => pointInPolygon(mx, my, poly))) off = 0;
    }
    // Inward normal of a CCW outline is to the left of a→b: (-dy, dx).
    lines.push({ p: [a[0] - dy * off, a[1] + dx * off], d: [dx, dy] });
  }
  const verts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n];
    const cur = lines[i];
    verts.push(lineIntersect(prev.p, prev.d, cur.p, cur.d) ?? simple[i]);
  }
  if (!verts.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1]))) return outline;
  const gross = polygonArea(simple);
  const got = polygonArea(verts);
  if (got <= 1e-6) return outline;
  if (mode === 'inner' && got > gross + 1e-6) return outline; // inset inverted
  return verts;
}

/** Ray-cast point-in-polygon test. */
function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Wall ids whose centreline an outline edge runs along (parallel, on the
 *  line, overlapping extent). `segments[k]` was extracted from `wallIds[k]`. */
function matchEdgeWalls(a: Vec2, b: Vec2, segments: Segment[], wallIds: number[]): number[] {
  const PERP_TOL = 0.2;       // m — edge sits on the wall centreline
  const PARALLEL_TOL = 0.03;
  const OVERLAP_MARGIN = 0.3; // m
  const out: number[] = [];
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  let ex = b[0] - a[0];
  let ey = b[1] - a[1];
  const el = Math.hypot(ex, ey);
  if (el < 1e-6) return out;
  ex /= el; ey /= el;
  for (let k = 0; k < segments.length; k++) {
    const sa = segments[k].a;
    const sb = segments[k].b;
    let sx = sb[0] - sa[0];
    let sy = sb[1] - sa[1];
    const sl = Math.hypot(sx, sy);
    if (sl < 1e-6) continue;
    sx /= sl; sy /= sl;
    if (Math.abs(ex * sy - ey * sx) > PARALLEL_TOL) continue;     // not parallel
    const t = (mx - sa[0]) * sx + (my - sa[1]) * sy;              // projection onto wall (m)
    const px = sa[0] + sx * t;
    const py = sa[1] + sy * t;
    if (Math.hypot(mx - px, my - py) > PERP_TOL) continue;        // edge off the wall line
    if (t < -OVERLAP_MARGIN || t > sl + OVERLAP_MARGIN) continue; // no extent overlap
    out.push(wallIds[k]);
  }
  return out;
}

/**
 * Build the IfcRelSpaceBoundary inputs for one room: map each outline edge to
 * the wall it runs along, classifying the boundary INTERNAL when another room
 * lies on the far side of that edge (a partition) or EXTERNAL when it's the
 * building perimeter. "Far side" is the edge midpoint nudged along its outward
 * normal — robust to neighbours that split the shared run differently than this
 * room does (where exact edge-matching would miss). A wall stays INTERNAL if
 * any of its edges has a room on the far side. One boundary per distinct wall.
 */
function buildSpaceBoundaries(
  outline: Vec2[],
  segments: Segment[],
  wallIds: number[],
  otherRooms: Vec2[][],
): SpaceBoundaryInput[] {
  const NUDGE = 0.1; // m past the shared centreline into the neighbour
  const byWall = new Map<number, 'INTERNAL' | 'EXTERNAL'>();
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) continue;
    dx /= dl; dy /= dl;
    // Outward normal of a CCW outline is to the right of a→b.
    const mx = (a[0] + b[0]) / 2 + dy * NUDGE;
    const my = (a[1] + b[1]) / 2 - dx * NUDGE;
    const cls = otherRooms.some((poly) => pointInPolygon(mx, my, poly)) ? 'INTERNAL' : 'EXTERNAL';
    for (const wallId of matchEdgeWalls(a, b, segments, wallIds)) {
      if (byWall.get(wallId) === 'INTERNAL') continue; // once internal, stays internal
      byWall.set(wallId, cls);
    }
  }
  return [...byWall].map(([elementId, internalOrExternal]) => ({
    elementId,
    internalOrExternal,
    physicalOrVirtual: 'PHYSICAL' as const,
  }));
}
