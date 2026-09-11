/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall footprint RECTANGLES for the face-based room derivation, read from the
 * RENDERED meshes — the exact geometry the user sees in the 3D scene and behind
 * the sketch as the construction underlay.
 *
 * Why not the STEP source geometry (`@ifc-lite/create` extract-walls)? Because a
 * source-geometry centreline is only ever self-consistent: it was repeatedly
 * validated against its OWN output, yet the room lines still landed off the
 * rendered walls. Measured on a real 1036-wall structural model, the source path
 * had (a) NO thickness for 0/1036 walls → every wall drawn at the 0.2 m default
 * while real walls span 0.08–1.04 m, and (b) a PCA-centroid axis bias up to
 * 0.33 m on thick walls. Deriving the rectangle straight from the rendered mesh
 * footprint eliminates both: the OBB width IS the rendered thickness, and the
 * min/max OBB axis is distribution-invariant. Room edges then sit on the rendered
 * wall faces to ~1 mm (measured), because they ARE the rendered faces.
 *
 * Frame: the rendered meshes are WebGL Y-up (`world = origin + position`). The
 * plan footprint is render XZ; we map it to the same "room frame" the underlay
 * uses (`useConstructionUnderlay`), which is the model's OWN IFC frame —
 * `ifcX = renderX + shift.x`, `ifcY = −renderZ − shift.z`.
 *
 * NOT the georeferenced world frame. `wasmRtcOffset` is the offset the WASM
 * mesh path subtracted when it resolved a site placement that anchors the
 * building to a survey grid; adding it back here yields survey coordinates,
 * and those are wrong for every consumer downstream. `addSpace` writes the
 * outline into a storey whose placement chain ALREADY carries that anchor, so
 * survey coordinates get the offset applied twice; the 3D ghost
 * (`buildElementMesh`) reads render-frame corners; and the storey band below
 * compares against render-frame mesh heights. Measured on a 6-storey LV95
 * model (rtc = 2665510 / 1259339 / 381.3 m, geometry local to ~360 m): the
 * band landed 381 m under the building so NO storey found a wall, and once it
 * did, the baked rooms were written 2.66 million metres off. rtc is null for
 * any model within 10 km of the origin, which is why neither showed up until
 * a georeferenced file arrived.
 *
 * Storey scoping is a render-Y (height) band overlap, so a full-height wall
 * correctly bounds rooms on every storey it passes through. `floorElevation`
 * is the storey's own `IfcBuildingStorey.Elevation` — local to the building,
 * the same frame the rendered geometry is in.
 *
 * The one consumer that DOES need the file's own placement-chain coordinates
 * — the Space Sketch bake, which divides the storey chain out of the outline
 * before `addSpace` (#4503) — gets the survey anchor back explicitly through
 * `roomFrameToModelWorld`, so the room frame stays local here and the bake
 * still folds through the right frame.
 */

import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

type Pt = [number, number];

/** One wall's footprint: the 4-corner rectangle (engine input), plus its
 *  centreline + thickness (for the diagnostics overlay / "has wall data"). */
export interface WallRect {
  corners: Pt[];
  centreline: [Pt, Pt];
  thickness: number;
}

const WALL_TYPES = new Set(['IfcWall', 'IfcWallStandardCase']);

/** OBB filter: drop slivers and anything too thick to be a wall (a mis-typed
 *  slab/footing caught in the band). */
const MIN_LEN = 0.3;
const MIN_THICK = 0.02;
const MAX_THICK = 2.5;
/** A wall is "on" a storey when its height range overlaps the band interior. */
const BAND_MARGIN = 0.2;

/**
 * The render → room-frame plan offsets: `ifcX = renderX + cx`,
 * `ifcY = cy − renderZ`.
 *
 * The room frame is the MODEL'S OWN IFC frame — `ifcLocal = renderLocal +
 * shift` with the Y-up→Z-up swap — NOT the georeferenced survey frame.
 * `wasmRtcOffset` is what the WASM mesh path subtracted when it resolved a
 * site placement that anchors the building to a survey grid; folding it back
 * in here would put the room frame a whole survey offset away from the
 * rendered walls and from the storey band below (see the module docstring
 * for the LV95 measurement that showed this). The anchor is carried by
 * {@link roomFrameToModelWorld} instead, for the one consumer that needs the
 * file's own placement-chain coordinates.
 *
 * Exported because this is where the room frame is DEFINED, and the bake needs
 * to know which frame that is — see {@link roomFrameToModelWorld}.
 */
export function roomFramePlanOffsets(coord: CoordinateInfo | undefined): { cx: number; cy: number } {
  const shift = coord?.originShift ?? { x: 0, y: 0, z: 0 };
  return { cx: shift.x, cy: -shift.z };
}

/**
 * The plan offset that takes a room-frame point into the MODEL'S OWN WORLD
 * FRAME — the coordinates the STEP file's placement chains resolve to, which
 * is the frame `storeyPlanFrame` reads the storey out of.
 *
 * Exactly the survey anchor {@link roomFramePlanOffsets} leaves out: the
 * canonical reconstruction is worldYup = renderLocal + shift + rtcYup with
 * rtcYup = { x: rtc.x, y: rtc.z, z: -rtc.y }, so ifcX gains `rtc.x` and
 * ifcY gains `rtc.y` on top of the room frame. Zero for any model within
 * ~10 km of the origin (rtc is null there). Anything that changes which
 * terms `roomFramePlanOffsets` carries changes this one too;
 * `wall-rects-from-meshes.test.ts` pins the two together.
 */
export function roomFrameToModelWorld(coord: CoordinateInfo | undefined): { dx: number; dy: number } {
  const rtc = coord?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 };
  return { dx: rtc.x, dy: rtc.y };
}

/** Convex hull (Andrew's monotone chain), CCW, of a plan point cloud. */
export function convexHull(pts: Pt[]): Pt[] {
  const uniq = [...new Map(pts.map((p) => [`${p[0].toFixed(5)},${p[1].toFixed(5)}`, p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (uniq.length < 3) return uniq;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * MINIMUM-AREA bounding rectangle of a thin plan point cloud (rotating calipers
 * on the convex hull) → its 4 CCW corners (long edge first), length, thickness.
 *
 * NOT PCA. PCA orients by minimizing variance, so on a wall whose mesh has uneven
 * vertex density (short structural stubs especially) the principal axis tilts by
 * several degrees even though the wall is axis-aligned — which skews the room into
 * a parallelogram. The min-area rectangle depends only on the footprint OUTLINE
 * (the hull), so it returns the true rectangle: measured 0.000° skew / 0 m off the
 * rendered faces on the storeys where PCA produced ~5° skew.
 */
export function footprintOBB(pts: Pt[]): { corners: [Pt, Pt, Pt, Pt]; length: number; thickness: number } | null {
  const h = convexHull(pts);
  if (h.length < 3) return null;
  let best: { area: number; corners: [Pt, Pt, Pt, Pt]; length: number; thickness: number } | null = null;
  // The min-area rectangle is collinear with one hull edge — try them all.
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    let ex = b[0] - a[0], ey = b[1] - a[1];
    const L = Math.hypot(ex, ey);
    if (L < 1e-9) continue;
    ex /= L; ey /= L;
    const nx = -ey, ny = ex; // +90° (CCW) of the edge dir
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const q of h) {
      const du = (q[0] - a[0]) * ex + (q[1] - a[1]) * ey;
      const dv = (q[0] - a[0]) * nx + (q[1] - a[1]) * ny;
      if (du < umin) umin = du; if (du > umax) umax = du;
      if (dv < vmin) vmin = dv; if (dv > vmax) vmax = dv;
    }
    const ulen = umax - umin, vlen = vmax - vmin;
    const area = ulen * vlen;
    if (best && area >= best.area) continue;
    const P = (du: number, dv: number): Pt => [a[0] + ex * du + nx * dv, a[1] + ey * du + ny * dv];
    // CCW corners; rotate so corners[0]→corners[1] is the LONG (length) axis,
    // which `wallRectsFromMeshes` relies on to take the centreline.
    let corners: [Pt, Pt, Pt, Pt] = [P(umin, vmin), P(umax, vmin), P(umax, vmax), P(umin, vmax)];
    if (ulen < vlen) corners = [corners[1], corners[2], corners[3], corners[0]];
    best = { area, corners, length: Math.max(ulen, vlen), thickness: Math.min(ulen, vlen) };
  }
  return best;
}

/**
 * Per-wall footprint rectangles (4 CCW corners, room frame) for the walls whose
 * height range overlaps the storey band `[floorElevation, floorElevation +
 * floorToFloor]`. Aggregates all mesh fragments of one wall (a void-cut wall
 * renders as several) by `expressId` before taking the OBB.
 */
export function wallRectsFromMeshes(
  meshes: readonly MeshData[],
  coord: CoordinateInfo | undefined,
  floorElevation: number,
  floorToFloor: number,
): WallRect[] {
  const shift = coord?.originShift ?? { x: 0, y: 0, z: 0 };
  // Render → the model's own IFC frame (no rtc term — see roomFramePlanOffsets).
  const { cx, cy } = roomFramePlanOffsets(coord);
  // Storey band in render-Y (height): renderY = ifcZ − shift.y. `floorElevation`
  // is the storey's own local Elevation, the frame the rendered geometry is in.
  const lo = floorElevation - shift.y;
  const hi = floorElevation + floorToFloor - shift.y;

  const walls = new Map<number, { pts: Pt[]; ymin: number; ymax: number }>();
  for (const m of meshes) {
    if (!m.ifcType || !WALL_TYPES.has(m.ifcType)) continue;
    const pos = m.positions;
    const o = m.origin ?? [0, 0, 0];
    let w = walls.get(m.expressId);
    if (!w) { w = { pts: [], ymin: Infinity, ymax: -Infinity }; walls.set(m.expressId, w); }
    for (let i = 0; i + 2 < pos.length; i += 3) {
      const rx = o[0] + pos[i], ry = o[1] + pos[i + 1], rz = o[2] + pos[i + 2];
      w.pts.push([rx + cx, cy - rz]);
      if (ry < w.ymin) w.ymin = ry;
      if (ry > w.ymax) w.ymax = ry;
    }
  }

  const out: WallRect[] = [];
  for (const w of walls.values()) {
    if (!(w.ymax > lo + BAND_MARGIN && w.ymin < hi - BAND_MARGIN)) continue; // not on this storey
    if (w.pts.length < 6) continue;
    const o = footprintOBB(w.pts);
    if (!o || o.length <= MIN_LEN || o.thickness <= MIN_THICK || o.thickness >= MAX_THICK) continue;
    const [c0, c1, c2, c3] = o.corners;
    // Centreline = the mid-thickness line along the long axis (mid of each short
    // edge). c0→c1 and c3→c2 are the long (face) edges.
    const a: Pt = [(c0[0] + c3[0]) / 2, (c0[1] + c3[1]) / 2];
    const b: Pt = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
    out.push({ corners: o.corners, centreline: [a, b], thickness: o.thickness });
  }
  return out;
}
