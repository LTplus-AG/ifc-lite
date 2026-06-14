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
 * uses (`useConstructionUnderlay`): `ifcX = renderX + cx`, `ifcY = cy − renderZ`,
 * with `cx = rtc.x − shift.x`, `cy = rtc.y + shift.z`. For models with no large
 * coordinate shift (rtc = shift = 0) this is `(renderX, −renderZ)` — identity to
 * IFC X/Y. Storey scoping is a render-Y (height) band overlap, so a full-height
 * wall correctly bounds rooms on every storey it passes through.
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

/** Oriented bounding box of a thin plan point cloud → its 4 CCW corners, length
 *  and thickness, via PCA + min/max extents (distribution-invariant). */
export function footprintOBB(pts: Pt[]): { corners: [Pt, Pt, Pt, Pt]; length: number; thickness: number } | null {
  const n = pts.length;
  if (n < 3) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let u: Pt = [Math.cos(ang), Math.sin(ang)];
  let nrm: Pt = [-Math.sin(ang), Math.cos(ang)];
  let umin = Infinity, umax = -Infinity, nmin = Infinity, nmax = -Infinity;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy;
    const pu = dx * u[0] + dy * u[1], pn = dx * nrm[0] + dy * nrm[1];
    if (pu < umin) umin = pu; if (pu > umax) umax = pu;
    if (pn < nmin) nmin = pn; if (pn > nmax) nmax = pn;
  }
  let len = umax - umin, thick = nmax - nmin;
  // Ensure u is the long (length) axis.
  if (thick > len) { [u, nrm] = [nrm, u]; [len, thick] = [thick, len]; const t0 = umin, t1 = umax; umin = nmin; umax = nmax; nmin = t0; nmax = t1; }
  const corner = (a: number, b: number): Pt => [cx + u[0] * a + nrm[0] * b, cy + u[1] * a + nrm[1] * b];
  return { corners: [corner(umin, nmin), corner(umax, nmin), corner(umax, nmax), corner(umin, nmax)], length: len, thickness: thick };
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
  const rtc = coord?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 };
  const shift = coord?.originShift ?? { x: 0, y: 0, z: 0 };
  const cx = rtc.x - shift.x;
  const cy = rtc.y + shift.z;
  // Storey band in render-Y (height). renderY = ifcZ − rtc.z + shift.y.
  const lo = floorElevation - rtc.z + shift.y;
  const hi = floorElevation + floorToFloor - rtc.z + shift.y;

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
