/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Tracing an arc through three points (`IfcArcIndex`), bounded and conservative in any frame. */

export type Pt2 = [number, number];

/**
 * Largest gap between an arc and its outline, either way, as a fraction of the
 * shorter of its radius and its length: 1 mm on a 20 m radius, 3 cm on a 624 m
 * arc of a 30 km radius (a nearly straight arc stays nearly straight).
 */
export const ARC_SAGITTA = 5e-5;

/** Most pieces one arc is traced in; beyond it the curve is unreadable (never an unbounded loop). */
export const ARC_MAX_PIECES = 4096;

/**
 * The points of an arc from `a` through `b` to `c`, after `a`: points on the
 * arc (its circle's axis-aligned extremes among them) alternating with the
 * corners where the tangents at neighbouring arc points meet, which lie just
 * outside the circle. The on-arc points bound a concave arc, the tangent
 * corners a convex one, so the extent of these points reaches the arc's in
 * every direction, in any frame the outline is later turned into (a
 * placement, a tilt, the map rotation), and lies within `ARC_SAGITTA` × radius
 * of it (relative to the shorter of radius and arc length). Three collinear
 * points, or an arc that bulges no more than that tolerance, are a straight
 * line (`b`, `c`). Null (the curve is unreadable) when the arc cannot be
 * traced in at most `ARC_MAX_PIECES` pieces: a reader must not loop or exhaust
 * memory on any input.
 */
export function arcPoints(a: Pt2, b: Pt2, c: Pt2): Pt2[] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return [b, c];
  const sq = (p: Pt2) => p[0] * p[0] + p[1] * p[1];
  const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - ux, a[1] - uy);
  const ang = (p: Pt2) => Math.atan2(p[1] - uy, p[0] - ux);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ta = ang(a);
  const ccw = norm(ang(b) - ta) < norm(ang(c) - ta);
  const along = (t: number) => (ccw ? norm(t - ta) : norm(ta - t));
  const sweep = along(ang(c));
  const at = (off: number, radius = r): Pt2 => {
    const t = ccw ? ta + off : ta - off;
    return [ux + radius * Math.cos(t), uy + radius * Math.sin(t)];
  };
  // Tangent points: both ends, the file's middle point, and every axis extreme on the arc, refined so that each piece spans at most 2h, where the
  // tangent corner (radius r / cos h) and the chord (r cos h from the centre) each stay within `tol` of the arc.
  const tol = ARC_SAGITTA * Math.min(r, r * sweep);
  if (!Number.isFinite(r) || !Number.isFinite(sweep) || !Number.isFinite(tol)) return null;
  // A nearly straight arc (a radius of 1e15 from three almost collinear points) bulges less than the tolerance: its chords.
  if (2 * r * Math.sin(sweep / 4) ** 2 <= tol) return [b, c];
  // Half the piece angle, stably: 1 - cos h = tol / (r + tol) loses everything to rounding when tol << r.
  const h = 2 * Math.asin(Math.sqrt(tol / (2 * (r + tol))));
  if (!(h > 0) || !Number.isFinite(sweep / h) || sweep / (2 * h) > ARC_MAX_PIECES) return null;
  const marks = [0, along(ang(b)), sweep];
  for (const e of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const off = along(e);
    if (off > 1e-9 && off < sweep - 1e-9) marks.push(off);
  }
  marks.sort((x, y) => x - y);
  const out: Pt2[] = [];
  for (let i = 1; i < marks.length; i++) {
    const [t0, t1] = [marks[i - 1], marks[i]];
    const n = Math.max(1, Math.ceil((t1 - t0) / (2 * h)));
    for (let k = 1; k <= n; k++) {
      const s0 = t0 + ((t1 - t0) * (k - 1)) / n;
      const s1 = t0 + ((t1 - t0) * k) / n;
      out.push(at((s0 + s1) / 2, r / Math.cos((s1 - s0) / 2)));
      out.push(k < n ? at(s1) : i === marks.length - 1 ? c : marks[i] === along(ang(b)) ? b : at(s1));
    }
  }
  return out;
}
