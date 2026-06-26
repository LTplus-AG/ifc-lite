// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::tessellation::TessellationQuality;
use crate::{Point2, Point3};
use std::f64::consts::PI;

/// Trim a sampled polyline (>=2 points) to its local parameter range
/// `[start, end]` where each segment between consecutive points contributes
/// `1/(n-1)` to the parameter. Returns the start interpolated point, all
/// intermediate sampled points strictly inside the range, and the end
/// interpolated point.
pub(super) fn trim_polyline(points: &[Point3<f64>], start: f64, end: f64) -> Vec<Point3<f64>> {
    let n = points.len();
    if n < 2 || end <= start {
        return Vec::new();
    }
    let s = start.clamp(0.0, 1.0);
    let e = end.clamp(0.0, 1.0);
    let denom = (n - 1) as f64;
    let lerp = |t: f64| -> Point3<f64> {
        let scaled = t * denom;
        let mut idx = scaled.floor() as usize;
        if idx >= n - 1 {
            return points[n - 1];
        }
        let frac = scaled - idx as f64;
        let a = points[idx];
        idx += 1;
        let b = points[idx];
        Point3::new(
            a.x + (b.x - a.x) * frac,
            a.y + (b.y - a.y) * frac,
            a.z + (b.z - a.z) * frac,
        )
    };
    let mut out = Vec::new();
    out.push(lerp(s));
    for (i, p) in points.iter().enumerate() {
        let t = i as f64 / denom;
        if t > s && t < e {
            out.push(*p);
        }
    }
    out.push(lerp(e));
    out
}

/// Approximate a 3-point arc as a polyline by fitting a circumcircle in the
/// plane spanned by the three points and sampling it uniformly in angle.
///
/// Falls back to the bare 3-point polyline when the points are colinear or the
/// fitted circle is degenerate (radius is unreasonably large compared to the
/// arc span — same threshold the 2D sibling uses).
pub(super) fn approximate_arc_3pt_3d(
    p1: Point3<f64>,
    p2: Point3<f64>,
    p3: Point3<f64>,
    num_segments: usize,
) -> Vec<Point3<f64>> {
    let a = p2 - p1;
    let b = p3 - p1;
    let normal = a.cross(&b);
    let normal_len_sq = normal.norm_squared();
    let arc_span = (p3 - p1).norm();
    // |a × b|² = 2 * (twice triangle area)² — colinear ⇒ ≈ 0.
    let collinear_tol = 1e-12_f64.max(arc_span.powi(4) * 1e-12);
    if normal_len_sq < collinear_tol {
        return vec![p1, p2, p3];
    }
    let n_hat = normal / normal_len_sq.sqrt();

    // Circumcenter via standard formula projected onto the {a, b} plane.
    let d11 = a.dot(&a);
    let d22 = b.dot(&b);
    let d12 = a.dot(&b);
    let denom = 2.0 * (d11 * d22 - d12 * d12);
    if denom.abs() < 1e-20 {
        return vec![p1, p2, p3];
    }
    let u = (d22 * (d11 - d12)) / denom;
    let v = (d11 * (d22 - d12)) / denom;
    let center = p1 + a * u + b * v;
    let radius = (p1 - center).norm();
    if radius > arc_span * 100.0 {
        return vec![p1, p2, p3];
    }

    // Local 2D frame in the arc plane: u_axis = (p1 - center) normalised,
    // v_axis = n_hat × u_axis. Angles read off via atan2 in this frame.
    let u_axis = (p1 - center) / radius;
    let v_axis = n_hat.cross(&u_axis);

    let angle_of = |pt: Point3<f64>| -> f64 {
        let r = pt - center;
        r.dot(&v_axis).atan2(r.dot(&u_axis))
    };
    let a1 = angle_of(p1); // ≈ 0 by construction
    let a2 = angle_of(p2);
    let a3 = angle_of(p3);

    // Choose sweep direction so we pass through p2.
    fn norm_pi(mut a: f64) -> f64 {
        let two_pi = 2.0 * std::f64::consts::PI;
        a %= two_pi;
        if a > std::f64::consts::PI {
            a -= two_pi;
        } else if a < -std::f64::consts::PI {
            a += two_pi;
        }
        a
    }
    let diff13 = norm_pi(a3 - a1);
    let diff12 = norm_pi(a2 - a1);
    let go_direct = if diff13 > 0.0 {
        diff12 > 0.0 && diff12 < diff13
    } else {
        diff12 < 0.0 && diff12 > diff13
    };
    let sweep = if go_direct {
        diff13
    } else if diff13 > 0.0 {
        diff13 - 2.0 * std::f64::consts::PI
    } else {
        diff13 + 2.0 * std::f64::consts::PI
    };

    let mut out = Vec::with_capacity(num_segments + 1);
    for i in 0..=num_segments {
        let t = i as f64 / num_segments as f64;
        let angle = a1 + t * sweep;
        let pt = center + (u_axis * radius * angle.cos()) + (v_axis * radius * angle.sin());
        out.push(pt);
    }
    out
}

/// Cheap dedup helper for 3D point sequences — used to avoid duplicating the
/// junction vertex when concatenating contiguous segments.
pub(super) fn same_point_3d(prev: Option<&Point3<f64>>, next: &Point3<f64>) -> bool {
    match prev {
        Some(p) => {
            (p.x - next.x).abs() < 1e-9
                && (p.y - next.y).abs() < 1e-9
                && (p.z - next.z).abs() < 1e-9
        }
        None => false,
    }
}

/// Build a rectangle outline with quarter-circle fillets at the four
/// corners. Used by `IfcRectangleHollowProfileDef` (outer + inner loops)
/// — see issue #854 for the case where the inner fillet equals the inner
/// half-dim and the loop degenerates to a full circle.
///
/// * `half_x` / `half_y` — half-extents of the rectangle, centred on origin.
/// * `radius` — fillet radius. `0` (or below 1 µm) emits sharp corners.
///   Caller must clamp to ≤ `min(half_x, half_y)`.
/// * `ccw` — output orientation. Profile outer loops are CCW; hole loops
///   are CW (per `Profile2D::add_hole`'s contract).
pub(super) fn rounded_rectangle_outline(
    half_x: f64,
    half_y: f64,
    radius: f64,
    ccw: bool,
    quality: TessellationQuality,
) -> Vec<Point2<f64>> {
    if radius <= 1.0e-9 {
        let pts = vec![
            Point2::new(-half_x, -half_y),
            Point2::new(half_x, -half_y),
            Point2::new(half_x, half_y),
            Point2::new(-half_x, half_y),
        ];
        return if ccw {
            pts
        } else {
            pts.into_iter().rev().collect()
        };
    }

    // 6 segments per corner at Medium+ matches `process_rounded_rectangle`;
    // coarser below Medium. Keeps the outline (and the extrusions these
    // profiles drive: HVAC diffuser shells, hollow tubular sections) cheap.
    let segments_per_corner = quality.profile_arc_segments(6, 2);
    let half_pi = PI / 2.0;
    let corners = [
        (half_x - radius, -half_y + radius, -half_pi, 0.0),
        (half_x - radius, half_y - radius, 0.0, half_pi),
        (-half_x + radius, half_y - radius, half_pi, PI),
        (-half_x + radius, -half_y + radius, PI, PI + half_pi),
    ];

    // Drop duplicate seam vertices when adjacent corners' arc endpoints
    // coincide. This happens when `radius == half_x` or `radius == half_y`
    // (the degenerate circle path that motivated issue #854 — the inner
    // fillet at 10/10 collapses to a single circle whose adjacent corner
    // arcs share their tangent point). Without dedup the contour
    // contains zero-length edges that earcutr handles but downstream
    // analytics / 2D drawing pipelines may not (PR #863 review). 1 µm
    // tolerance in profile units matches the welding precision used
    // elsewhere in the geometry pipeline.
    let mut points: Vec<Point2<f64>> = Vec::with_capacity((segments_per_corner + 1) * 4);
    const SEAM_TOL: f64 = 1.0e-6;
    for (cx, cy, a0, a1) in corners {
        for i in 0..=segments_per_corner {
            let t = i as f64 / segments_per_corner as f64;
            let a = a0 + (a1 - a0) * t;
            let pt = Point2::new(cx + radius * a.cos(), cy + radius * a.sin());
            if let Some(prev) = points.last() {
                if (prev.x - pt.x).abs() < SEAM_TOL && (prev.y - pt.y).abs() < SEAM_TOL {
                    continue;
                }
            }
            points.push(pt);
        }
    }
    // For the exact-circle case the final vertex also coincides with
    // the first — same dedup logic, wrapping around.
    if points.len() >= 2 {
        let first = points[0];
        let last = points[points.len() - 1];
        if (first.x - last.x).abs() < SEAM_TOL && (first.y - last.y).abs() < SEAM_TOL {
            points.pop();
        }
    }
    if !ccw {
        points.reverse();
    }
    points
}

/// Append `pt` unless it coincides (within 1 µm on both axes) with the current
/// last point. Adjacent arcs/segments in a steel-section contour can meet at the
/// exact same coordinate — e.g. an L-shape where `width == thickness + fillet +
/// edge` puts the toe arc's end on the inner fillet's start — and emitting both
/// hands a zero-length edge to downstream tessellation/CSG. Mirrors the
/// seam-degeneracy guard in `rounded_rectangle_outline`.
fn push_dedup(out: &mut Vec<Point2<f64>>, pt: Point2<f64>) {
    if out
        .last()
        .is_none_or(|p| (p.x - pt.x).abs() > 1.0e-9 || (p.y - pt.y).abs() > 1.0e-9)
    {
        out.push(pt);
    }
}

/// Append a circular arc (radius `r`, centre (`cx`,`cy`)) sweeping from angle
/// `a0` to `a1` as up to `segments + 1` points. Used to round parametric
/// steel-section corners (IfcLShapeProfileDef FilletRadius / EdgeRadius, etc.).
/// Coincident endpoints (with the prior contour point, or a zero-length arc) are
/// dropped via [`push_dedup`].
pub(super) fn push_arc(
    out: &mut Vec<Point2<f64>>,
    cx: f64,
    cy: f64,
    r: f64,
    a0: f64,
    a1: f64,
    segments: usize,
) {
    let n = segments.max(1);
    for i in 0..=n {
        let t = i as f64 / n as f64;
        let a = a0 + (a1 - a0) * t;
        push_dedup(out, Point2::new(cx + r * a.cos(), cy + r * a.sin()));
    }
}

/// Round a (right-angle) corner with a tangent fillet of radius `r`, replacing
/// the sharp `corner` with an arc tangent to the incoming edge `prev->corner`
/// and the outgoing edge `corner->next`. Returns the arc points from the
/// incoming tangent point to the outgoing one (so the caller drops the sharp
/// corner). The fillet centre is placed on the side the edges turn toward, so
/// the same call rounds a concave (re-entrant, material-adding) corner and a
/// convex (toe, material-removing) corner correctly. When `r` is below 1 µm or
/// the edges are degenerate, the sharp `corner` is returned unchanged.
///
/// Used for the steel-section web/flange fillets and toe edge radii
/// (IfcL/U/T/I-ShapeProfileDef). For a 90° corner the tangent points sit `r`
/// from the corner along each edge and the centre at `corner - e_in*r + e_out*r`.
fn round_corner(
    prev: Point2<f64>,
    corner: Point2<f64>,
    next: Point2<f64>,
    r: f64,
    segments: usize,
) -> Vec<Point2<f64>> {
    if r <= 1.0e-9 {
        return vec![corner];
    }
    let ein = corner - prev;
    let eout = next - corner;
    let (ein_n, eout_n) = (ein.norm(), eout.norm());
    // Need both edges at least `r` long to fit the tangent points, else the
    // fillet would overrun the edge — fall back to a sharp corner.
    if ein_n < r || eout_n < r {
        return vec![corner];
    }
    let ein = ein / ein_n;
    let eout = eout / eout_n;
    let t_in = corner - ein * r; // tangent point on the incoming edge
    let t_out = corner + eout * r; // tangent point on the outgoing edge
    let center = corner - ein * r + eout * r;
    let a0 = (t_in.y - center.y).atan2(t_in.x - center.x);
    let mut a1 = (t_out.y - center.y).atan2(t_out.x - center.x);
    // Sweep the short way (a 90° corner gives a quarter arc).
    while a1 - a0 > std::f64::consts::PI {
        a1 -= 2.0 * std::f64::consts::PI;
    }
    while a0 - a1 > std::f64::consts::PI {
        a1 += 2.0 * std::f64::consts::PI;
    }
    let mut out = Vec::with_capacity(segments + 1);
    push_arc(&mut out, center.x, center.y, r, a0, a1, segments);
    out
}

/// Build a closed outline from `sharp` corners, rounding the corners named in
/// `radii` (index → radius) with tangent fillets via [`round_corner`]. Corners
/// not listed (or with radius ≤ 0) stay sharp. Indices wrap, so a corner at the
/// seam still sees its true neighbours. Used by the L/U/T/I parametric steel
/// sections; the radius's concave/convex sense is handled by `round_corner`.
pub(super) fn fillet_outline(
    sharp: &[Point2<f64>],
    radii: &[(usize, f64)],
    segments: usize,
) -> Vec<Point2<f64>> {
    let n = sharp.len();
    let mut out: Vec<Point2<f64>> = Vec::with_capacity(n + radii.len() * segments);
    for i in 0..n {
        let r = radii
            .iter()
            .find(|(idx, _)| *idx == i)
            .map(|(_, r)| *r)
            .unwrap_or(0.0);
        if r > 1.0e-9 {
            for pt in round_corner(sharp[(i + n - 1) % n], sharp[i], sharp[(i + 1) % n], r, segments)
            {
                push_dedup(&mut out, pt);
            }
        } else {
            push_dedup(&mut out, sharp[i]);
        }
    }
    // Drop a closing-seam duplicate (first ≈ last) so the closed contour carries
    // no zero-length edge across the wrap.
    if out.len() > 1 {
        let (first, last) = (out[0], out[out.len() - 1]);
        if (first.x - last.x).abs() <= 1.0e-9 && (first.y - last.y).abs() <= 1.0e-9 {
            out.pop();
        }
    }
    out
}
