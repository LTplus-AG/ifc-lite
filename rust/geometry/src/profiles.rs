// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Profile Processors - Handle all IFC profile types
//!
//! Dynamic profile processing for parametric, arbitrary, and composite profiles.

use crate::profile::Profile2D;
use crate::tessellation::{scale_segments, TessellationQuality};
use crate::{Error, Point2, Point3, Result, Vector3};
use ifc_lite_core::{
    AttributeValue, DecodedEntity, EntityDecoder, IfcSchema, IfcType, ProfileCategory,
};
use std::cell::Cell;
use std::f64::consts::PI;

/// Maximum recursion depth for nested curve processing.
/// Prevents stack overflow from deeply nested CompositeCurve → TrimmedCurve → CompositeCurve chains.
const MAX_CURVE_DEPTH: u32 = 50;

/// One bound of an `IfcTrimmingSelect` on a trimmed conic. A `Parameter` is an
/// angle in the project's PLANEANGLEUNIT; a `Cartesian` point is resolved to an
/// angle against the conic's own placement and radii once those are known.
#[derive(Debug, Clone, Copy)]
enum TrimSelect {
    Parameter(f64),
    Cartesian(Point2<f64>),
}

/// Issue #635 — when an `IfcArbitraryClosedProfileDef` is actually a smooth
/// curve approximated by a many-vertex polyline (e.g. a 127-vertex circle
/// stand-in for a round window), the resulting prism has too many side
/// triangles to fit in the BSP CSG polygon budget and the void cut falls
/// back to an axis-aligned box, turning round windows into squares.
///
/// Detect over-tessellated curves by comparing average vertex spacing to
/// the polygon's bounding-box diagonal — anything denser than this ratio
/// is treated as a curve approximation and downsampled with
/// Ramer-Douglas-Peucker so it tessellates into far fewer triangles while
/// remaining visually circular.
const SMOOTH_CURVE_SPACING_RATIO: f64 = 1.0 / 16.0;
/// Max single-edge length as a fraction of the bounding-box diagonal for a
/// polyline to qualify as an over-tessellated smooth curve. A uniformly
/// sampled curve has every edge much shorter than the profile diagonal; a
/// mixed-geometry profile (e.g. Revit I-beam authored as polyline+fillet-arc
/// composite) has a few flange-top edges that are a large fraction of the
/// diagonal alongside many short arc-sampling edges, which makes
/// `mean_edge/diag` alone read as "smooth" while the polygon is anything but.
/// Reject simplification whenever a single edge exceeds this ratio so RDP
/// never gets a chance to slice through a sharp polyline corner adjacent to a
/// fillet arc — that pattern is what produced the +4.31% W410x60 area bug.
const SMOOTH_CURVE_LONGEST_EDGE_RATIO: f64 = 0.10;
/// RDP epsilon as fraction of bounding-box diagonal. Larger ⇒ coarser
/// approximation. For a unit-diameter circle, an N-segment polygon's
/// max sagitta is `r * (1 - cos(π/N))`; targeting N≈16 (recognizable
/// circle) on a 1m-diagonal bbox needs eps ≈ 1/100 of the diagonal.
const RDP_EPSILON_RATIO: f64 = 1.0 / 100.0;
/// Absolute lower bound on RDP epsilon, in profile units (typically meters).
/// Prevents collapsing tiny profiles where ratio-derived epsilon would be
/// numerically negligible.
const RDP_EPSILON_MIN: f64 = 5.0e-3;
/// Minimum ratio of a profile's half-thickness (`area / perimeter`, its
/// hydraulic radius) to its bounding-box diagonal for simplification to be
/// attempted. Below this the profile is a *thin* curved sliver — e.g. a
/// trimmed-circle wall whose inner and outer arcs sit only a wall-thickness
/// apart (issue #820) — and RDP's diagonal-scaled epsilon would distort or fold
/// its feature size; such profiles are left untouched. A round window sits far
/// above this (half-thickness ≈ r/2 against a bbox diagonal of 2·r·√2 gives
/// ≈ 0.18, ~3.5× the gate) and still simplifies. Thinness alone is *not*
/// sufficient to skip — an elongated filled ellipse is thin by this measure too
/// yet simplifies fine — so it is paired with [`DOUBLE_BACK_REFLEX_ARC_FRACTION`].
const THIN_FEATURE_RATIO: f64 = 0.05;
/// Fraction of a loop's *perimeter length* that must run along reflex vertices
/// (turning against the loop's overall winding) for it to count as *doubling
/// back* on itself rather than enclosing a convex-ish blob. A convex shape
/// (filled ellipse, disk) has zero reflex boundary at any aspect ratio; an
/// annular sector's entire inner arc is reflex, so ~half its perimeter is
/// (≈0.5). 0.15 sits clear of both, and measuring by arc *length* rather than
/// vertex *count* makes it independent of how densely each boundary is sampled
/// — a thin wall whose inner arc carries far fewer points than its outer arc
/// still reads as ~0.5 (Codex review). It is likewise insensitive to a
/// *localized* spike: one inward notch or a sub-mm closing-seam jog spans
/// negligible arc length, so such convex thin openings keep simplifying (else
/// they regress to the issue #635 AABB cut).
const DOUBLE_BACK_REFLEX_ARC_FRACTION: f64 = 0.15;
/// Per-vertex turning (as |sin| of the deflection angle) below which a vertex
/// is treated as straight, not reflex — guards the reflex test against f64
/// noise at near-collinear samples on a convex curve.
const REFLEX_TURN_SIN_TOL: f64 = 1.0e-6;
/// Only attempt simplification when the polyline has at least this many
/// vertices. Below this the polyline is already cheap enough.
const SMOOTH_CURVE_MIN_VERTICES: usize = 24;
/// Never simplify below this many vertices — keeps the approximation
/// recognizably round (16-gon reads as a circle).
const SIMPLIFIED_MIN_VERTICES: usize = 12;

/// Perpendicular distance from `p` to the line through `a` and `b`.
#[inline]
/// Mirror every point of a `Profile2D` about the local Y-axis (x → −x).
///
/// `IfcMirroredProfileDef` per IFC4 §8.6.2.21 produces a profile that is
/// the parent profile reflected about its own Y-axis. Reflection is
/// orientation-reversing, so we also reverse the winding order of each
/// contour to keep outer loops CCW and holes CW — without this the
/// downstream earcut tessellator would emit inside-out triangles.
fn mirror_profile_about_y_axis(profile: &mut Profile2D) {
    for p in &mut profile.outer {
        p.x = -p.x;
    }
    profile.outer.reverse();
    for hole in &mut profile.holes {
        for p in hole.iter_mut() {
            p.x = -p.x;
        }
        hole.reverse();
    }
}

fn perpendicular_distance(p: Point2<f64>, a: Point2<f64>, b: Point2<f64>) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len_sq = dx * dx + dy * dy;
    if len_sq < f64::EPSILON {
        let ex = p.x - a.x;
        let ey = p.y - a.y;
        return (ex * ex + ey * ey).sqrt();
    }
    // |(p - a) × (b - a)| / |b - a|
    let cross = (p.x - a.x) * dy - (p.y - a.y) * dx;
    cross.abs() / len_sq.sqrt()
}

/// Ramer-Douglas-Peucker simplification of an open polyline.
/// Iterative implementation (no recursion) to keep stack usage small —
/// arbitrary IFC profiles can run into the thousands of vertices.
fn rdp_simplify_open(points: &[Point2<f64>], epsilon: f64) -> Vec<Point2<f64>> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    // Stack of (start, end) index pairs to process.
    let mut stack: Vec<(usize, usize)> = Vec::new();
    stack.push((0, n - 1));
    while let Some((start, end)) = stack.pop() {
        if end <= start + 1 {
            continue;
        }
        let a = points[start];
        let b = points[end];
        let mut max_dist = 0.0;
        let mut max_idx = start;
        for (i, p) in points.iter().enumerate().take(end).skip(start + 1) {
            let d = perpendicular_distance(*p, a, b);
            if d > max_dist {
                max_dist = d;
                max_idx = i;
            }
        }
        if max_dist > epsilon {
            keep[max_idx] = true;
            stack.push((start, max_idx));
            stack.push((max_idx, end));
        }
    }
    points
        .iter()
        .enumerate()
        .filter_map(|(i, p)| if keep[i] { Some(*p) } else { None })
        .collect()
}

/// Vertex-count ceiling for the brute-force O(n²) self-intersection scan.
/// Above this the scan is too expensive to run per profile; the *caller*
/// treats an over-ceiling simplified loop as unconfirmed and falls back to the
/// faithful original (fail-safe) rather than trusting it. A simplification that
/// still has this many vertices barely beat the original anyway, so the
/// fallback is essentially free.
const SELF_INTERSECT_SCAN_MAX_VERTICES: usize = 1024;

/// Whether the closed polygon described by `loop_` (open form — the closing
/// edge from the last vertex back to the first is implied) has any pair of
/// non-adjacent edges that properly cross. Used to reject a simplification
/// that turned a simple profile loop into a self-intersecting one.
///
/// Brute-force O(n²), so only meaningful up to `SELF_INTERSECT_SCAN_MAX_VERTICES`
/// vertices; above that it returns `false` without scanning and callers must
/// apply their own size cap (see `simplify_smooth_curve_polyline`). Adjacent
/// edges (which legitimately share a vertex) are skipped, and only *proper*
/// crossings count, so the shared endpoints of consecutive segments never
/// register as intersections.
fn closed_loop_self_intersects(loop_: &[Point2<f64>]) -> bool {
    let n = loop_.len();
    if !(4..=SELF_INTERSECT_SCAN_MAX_VERTICES).contains(&n) {
        return false;
    }
    // Orientation of the triplet (a, b, c): >0 CCW, <0 CW, 0 collinear.
    #[inline]
    fn orient(a: Point2<f64>, b: Point2<f64>, c: Point2<f64>) -> f64 {
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    }
    // Proper crossing of segment ab and segment cd (interiors intersect at a
    // single point). Collinear/touching-endpoint cases return false — those
    // are how consecutive boundary edges legitimately meet.
    #[inline]
    fn segments_properly_cross(
        a: Point2<f64>,
        b: Point2<f64>,
        c: Point2<f64>,
        d: Point2<f64>,
    ) -> bool {
        let d1 = orient(c, d, a);
        let d2 = orient(c, d, b);
        let d3 = orient(a, b, c);
        let d4 = orient(a, b, d);
        ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
    }
    for i in 0..n {
        let a = loop_[i];
        let b = loop_[(i + 1) % n];
        for j in (i + 1)..n {
            // Skip the two segments adjacent to edge i (they share a vertex).
            // `j > i` already holds, so only the wrap-around adjacency
            // (j is the segment just before i) and the immediate successor
            // (j == i + 1) can touch edge i.
            if (j + 1) % n == i || (i + 1) % n == j {
                continue;
            }
            let c = loop_[j];
            let d = loop_[(j + 1) % n];
            if segments_properly_cross(a, b, c, d) {
                return true;
            }
        }
    }
    false
}

/// Whether the closed polygon (open form) `loop_` *doubles back* on itself —
/// the share of its perimeter that runs along reflex vertices (turning against
/// its winding) exceeds `DOUBLE_BACK_REFLEX_ARC_FRACTION`.
///
/// A convex shape (filled ellipse, disk) has no reflex boundary at any aspect
/// ratio. A loop that runs out along one boundary and back along another (an
/// annular sector / thin curved wall) makes its entire return arc reflex, so
/// ~half its perimeter is. Two properties matter:
///   * Measuring reflex *arc length* (not vertex *count*) makes the test
///     independent of per-boundary sampling density — a thin wall whose inner
///     arc carries far fewer points than its outer arc still reads as ~0.5,
///     whereas a count fraction would be skewed below the threshold.
///   * It stays insensitive to a *localized* feature — one inward notch, or the
///     sub-mm out-and-back jog where a composite curve closes — because that
///     spans negligible arc length, whereas a total-turning measure
///     double-counts such a spike and would wrongly flag the loop.
///
/// Winding is taken from the signed area; a vertex is reflex when its turn
/// opposes that winding by more than `REFLEX_TURN_SIN_TOL` (normalised so the
/// tolerance is a true angle, not a length-scaled cross product). Each reflex
/// vertex contributes its outgoing edge length, so the reflex arc length and
/// the perimeter are summed over the same edges.
fn loop_doubles_back(loop_: &[Point2<f64>]) -> bool {
    let n = loop_.len();
    if n < 4 {
        return false;
    }
    let mut signed_area2 = 0.0;
    for i in 0..n {
        let a = loop_[i];
        let b = loop_[(i + 1) % n];
        signed_area2 += a.x * b.y - b.x * a.y;
    }
    if signed_area2 == 0.0 {
        return false;
    }
    let winding = signed_area2.signum();

    let mut perimeter = 0.0;
    let mut reflex_len = 0.0;
    for i in 0..n {
        let prev = loop_[(i + n - 1) % n];
        let cur = loop_[i];
        let next = loop_[(i + 1) % n];
        let (ex_in, ey_in) = (cur.x - prev.x, cur.y - prev.y);
        let (ex_out, ey_out) = (next.x - cur.x, next.y - cur.y);
        let out_len = (ex_out * ex_out + ey_out * ey_out).sqrt();
        perimeter += out_len;
        let in_len = (ex_in * ex_in + ey_in * ey_in).sqrt();
        let denom = in_len * out_len;
        if denom <= 0.0 {
            continue; // zero-length edge (duplicate vertex) — no turn
        }
        // sin(turn) = cross / (|e_in||e_out|); reflex when it opposes winding.
        let sin_turn = (ex_in * ey_out - ey_in * ex_out) / denom;
        if sin_turn * winding < -REFLEX_TURN_SIN_TOL {
            reflex_len += out_len;
        }
    }
    perimeter > 0.0 && reflex_len / perimeter > DOUBLE_BACK_REFLEX_ARC_FRACTION
}

/// Best-effort downsampling of a polyline that might approximate a smooth
/// curve. Closed-loop aware (last == first is preserved). Returns the
/// original polyline unchanged when it doesn't look over-tessellated or
/// when simplification would drop it below `SIMPLIFIED_MIN_VERTICES`.
///
/// See `SMOOTH_CURVE_SPACING_RATIO` for the detection criterion.
pub(crate) fn simplify_smooth_curve_polyline(points: &[Point2<f64>]) -> Vec<Point2<f64>> {
    let raw_len = points.len();
    if raw_len < SMOOTH_CURVE_MIN_VERTICES {
        return points.to_vec();
    }

    // A closed polyline may or may not duplicate its first vertex at the
    // end. Strip the duplicate for the analysis and add it back at the
    // end if the input had it.
    let closed = raw_len >= 2
        && (points[0].x - points[raw_len - 1].x).abs() < 1e-9
        && (points[0].y - points[raw_len - 1].y).abs() < 1e-9;
    let core: &[Point2<f64>] = if closed {
        &points[..raw_len - 1]
    } else {
        points
    };
    let n = core.len();
    if n < SMOOTH_CURVE_MIN_VERTICES {
        return points.to_vec();
    }

    // Bounding box + diagonal (proxy for "size of profile").
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in core {
        if p.x < min_x {
            min_x = p.x;
        }
        if p.y < min_y {
            min_y = p.y;
        }
        if p.x > max_x {
            max_x = p.x;
        }
        if p.y > max_y {
            max_y = p.y;
        }
    }
    let dx = max_x - min_x;
    let dy = max_y - min_y;
    let diag = (dx * dx + dy * dy).sqrt();
    if !diag.is_finite() || diag < f64::EPSILON {
        return points.to_vec();
    }

    // Edge-length statistics. A smooth-curve approximation has every edge
    // short relative to the diagonal AND uniformly sized; mixed-geometry
    // profiles (e.g. I-beam authored as polyline + fillet arcs) have a few
    // long straight edges alongside many short arc-sampling edges and must
    // not be simplified — RDP would drop the polyline corner vertices that
    // define the silhouette and slice across the fillet region instead.
    let mut perimeter = 0.0;
    let mut longest_edge: f64 = 0.0;
    let mut area2 = 0.0; // 2× signed shoelace area
    for i in 0..n {
        let a = core[i];
        let b = core[(i + 1) % n];
        let ex = b.x - a.x;
        let ey = b.y - a.y;
        let len = (ex * ex + ey * ey).sqrt();
        perimeter += len;
        if len > longest_edge {
            longest_edge = len;
        }
        area2 += a.x * b.y - b.x * a.y;
    }
    let mean_edge = perimeter / n as f64;
    if mean_edge / diag > SMOOTH_CURVE_SPACING_RATIO {
        // Doesn't look like a smooth curve approximation — leave alone.
        return points.to_vec();
    }
    if longest_edge / diag > SMOOTH_CURVE_LONGEST_EDGE_RATIO {
        // Mixed-geometry profile: at least one edge is too long to belong to
        // a uniformly-tessellated smooth curve. Leave the polyline alone.
        return points.to_vec();
    }

    // Thin doubling-back gate (issue #820). RDP's epsilon is scaled to the
    // bounding diagonal, which is right for a "fat" smooth shape — a round
    // window is ~uniformly thick in every direction — but wrong for a *thin*
    // one that folds back on itself. A curved annular-sector wall is only a
    // wall thickness deep yet metres across, so a diagonal-scaled chord budget
    // is a large fraction of (or exceeds) the thickness; RDP then slides chords
    // across the thin dimension, letting the inner and outer arcs drift
    // independently: the footprint either folds into a self-intersecting flap
    // (the visible #820 bug) or silently gains/loses double-digit-percent area
    // while staying topologically simple (the same distortion class as the
    // +4.31% W410 fillet bug). No epsilon you can still call "simplification"
    // preserves such a shape, so don't try — keep the faithful original.
    //
    // Both conditions are required, because *thinness alone* is ambiguous:
    //  * `area / perimeter` (the hydraulic radius, ≈ half the mean thickness)
    //    over the diagonal is tiny both for a thin-walled ring (≈0.0015 for the
    //    100 mm × 24 m #820 wall) AND for an elongated *filled* ellipse — an
    //    8:1 opening sits at ≈0.048, below any thinness cutoff — yet the convex
    //    ellipse simplifies perfectly and *must* keep simplifying so its void
    //    cut fits the BSP polygon budget (else round openings → AABB boxes,
    //    issue #635).
    //  * What actually breaks RDP is the boundary *doubling back* on itself.
    //    A convex loop has no reflex boundary at any aspect ratio; an annular
    //    sector's inner arc is entirely reflex, so ~half its perimeter is.
    //    `loop_doubles_back` measures that reflex arc-length fraction, which
    //    distinguishes a thin ring from a thin ellipse, is independent of how
    //    densely each boundary is sampled, and — unlike a total-turning measure
    //    — ignores a lone notch or closing-seam jog. Requiring thinness too
    //    leaves *fat* curved walls (thickness ≫ epsilon, no fold) free to
    //    simplify.
    let half_thickness = if perimeter > f64::EPSILON {
        area2.abs() / (2.0 * perimeter)
    } else {
        0.0
    };
    let is_thin = half_thickness / diag < THIN_FEATURE_RATIO;
    if is_thin && loop_doubles_back(core) {
        return points.to_vec();
    }

    let epsilon = (diag * RDP_EPSILON_RATIO).max(RDP_EPSILON_MIN);

    // RDP needs distinct endpoints; rotate-then-simplify by treating the
    // closed loop as an open polyline whose first/last vertex are pinned.
    // This anchors the cut artificially but for symmetric near-circular
    // profiles the result is still ~uniformly spaced.
    let mut working: Vec<Point2<f64>> = core.to_vec();
    working.push(core[0]); // pin the loop closed for RDP
    let simplified = rdp_simplify_open(&working, epsilon);

    // Drop the duplicated closing vertex from RDP's output before the
    // sufficiency check.
    let mut simplified_core = simplified;
    if simplified_core.len() >= 2 {
        let last = simplified_core.len() - 1;
        if (simplified_core[0].x - simplified_core[last].x).abs() < 1e-9
            && (simplified_core[0].y - simplified_core[last].y).abs() < 1e-9
        {
            simplified_core.pop();
        }
    }

    if simplified_core.len() < SIMPLIFIED_MIN_VERTICES || simplified_core.len() >= n {
        // Either too aggressive or no real reduction — keep the original
        // so we never make an opening worse than it already was.
        return points.to_vec();
    }

    // Backstop: a valid simplification of a simple polygon stays simple. The
    // thickness-capped epsilon above prevents RDP from crossing a thin seam in
    // the common case, but pin placement and non-uniform sampling can still
    // produce a self-intersecting loop, so reject any result we can't confirm
    // is simple and keep the faithful original. Loops too large to scan within
    // the O(n²) budget are treated as unconfirmed (fail-safe) rather than
    // assumed clean — a simplification that still has >1024 vertices barely
    // beat the original, so falling back to it costs almost nothing.
    if simplified_core.len() > SELF_INTERSECT_SCAN_MAX_VERTICES
        || closed_loop_self_intersects(&simplified_core)
    {
        return points.to_vec();
    }

    if closed {
        let first = simplified_core[0];
        simplified_core.push(first);
    }
    simplified_core
}

/// Maximum recursion depth for nested profile definitions (DerivedProfile → parent → parent...).
/// Prevents stack overflow in WASM from Revit exports with deep profile nesting.
const MAX_PROFILE_DEPTH: u32 = 16;

/// Trim a sampled polyline (>=2 points) to its local parameter range
/// `[start, end]` where each segment between consecutive points contributes
/// `1/(n-1)` to the parameter. Returns the start interpolated point, all
/// intermediate sampled points strictly inside the range, and the end
/// interpolated point.
fn trim_polyline(points: &[Point3<f64>], start: f64, end: f64) -> Vec<Point3<f64>> {
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
fn approximate_arc_3pt_3d(
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
fn same_point_3d(prev: Option<&Point3<f64>>, next: &Point3<f64>) -> bool {
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
fn rounded_rectangle_outline(
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

    // 6 segments per corner at Medium+; coarser below Medium.
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
    // throughout `manifold_kernel.rs`.
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
        .map_or(true, |p| (p.x - pt.x).abs() > 1.0e-9 || (p.y - pt.y).abs() > 1.0e-9)
    {
        out.push(pt);
    }
}

/// Append a circular arc (radius `r`, centre (`cx`,`cy`)) sweeping from angle
/// `a0` to `a1` as up to `segments + 1` points. Used to round parametric
/// steel-section corners (IfcLShapeProfileDef FilletRadius / EdgeRadius, etc.).
/// Coincident endpoints (with the prior contour point, or a zero-length arc) are
/// dropped via [`push_dedup`].
fn push_arc(
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
    let mut a0 = (t_in.y - center.y).atan2(t_in.x - center.x);
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
fn fillet_outline(
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

/// Profile processor - processes IFC profiles into 2D contours
pub struct ProfileProcessor {
    schema: IfcSchema,
    /// Tessellation detail for the in-flight `process`/`get_curve_points` call.
    /// Set at those entry points and read by the curve/arc tessellators below,
    /// avoiding a `quality` parameter on every internal curve method. Single
    /// router instance is single-threaded (the router holds `RefCell` caches),
    /// so a `Cell` is sufficient. Defaults to [`TessellationQuality::Medium`].
    active_quality: Cell<TessellationQuality>,
}

impl ProfileProcessor {
    /// Create new profile processor
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            schema,
            active_quality: Cell::new(TessellationQuality::Medium),
        }
    }

    /// Tessellation detail selected for the current call.
    #[inline]
    fn quality(&self) -> TessellationQuality {
        self.active_quality.get()
    }

    /// Set the tessellation detail for subsequent curve sampling.
    ///
    /// [`process`](Self::process) and [`get_curve_points`](Self::get_curve_points)
    /// set this themselves; call it explicitly before the lower-level samplers
    /// (`get_composite_curve_points_trimmed`, `get_polyline_points_trimmed`)
    /// that don't take a `quality` argument.
    #[inline]
    pub fn set_tessellation_quality(&self, quality: TessellationQuality) {
        self.active_quality.set(quality);
    }

    /// Process any IFC profile definition at the given tessellation `quality`.
    ///
    /// Profile-plane tessellation (the 2D outline that becomes an extruded cap
    /// or an opening cutter) never gets *finer* above `Medium` — denser opening
    /// circles only multiply the earcut cap-bridge slivers that show up as scar
    /// lines on plates with bolt holes (issue #976). Below `Medium` they do get
    /// *coarser*: circular profiles via
    /// [`TessellationQuality::circle_profile_segments`], and profile arcs/fillets
    /// (rounded rectangles, steel-section root fillets, trimmed conics,
    /// indexed-polycurve arcs) via [`TessellationQuality::profile_arc_segments`].
    /// The quality knob drives the *curved 3D surfaces* instead — swept paths (via
    /// [`get_curve_points`](Self::get_curve_points)), cylinders, surfaces of
    /// revolution, NURBS, and brep edges — where faceting is actually visible.
    #[inline]
    pub fn process(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Profile2D> {
        self.active_quality.set(quality);
        self.process_with_depth(profile, decoder, 0)
    }

    /// Process profile with depth tracking to prevent stack overflow from nested profiles.
    fn process_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Profile2D> {
        if depth > MAX_PROFILE_DEPTH {
            return Err(Error::geometry(format!(
                "Profile nesting depth {} exceeds limit {} at #{}",
                depth, MAX_PROFILE_DEPTH, profile.id
            )));
        }
        match profile.ifc_type {
            IfcType::IfcDerivedProfileDef | IfcType::IfcMirroredProfileDef => {
                self.process_derived_with_depth(profile, decoder, depth)
            }
            _ => match self.schema.profile_category(&profile.ifc_type) {
                Some(ProfileCategory::Parametric) => self.process_parametric(profile, decoder),
                Some(ProfileCategory::Arbitrary) => self.process_arbitrary(profile, decoder),
                Some(ProfileCategory::Composite) => self.process_composite_with_depth(profile, decoder, depth),
                _ => Err(Error::geometry(format!(
                    "Unsupported profile type: {}",
                    profile.ifc_type
                ))),
            },
        }
    }

    /// Process parametric profiles (rectangle, circle, I-shape, etc.)
    #[inline]
    fn process_parametric(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Profile2D> {
        // First create the base profile shape
        let mut base_profile = match profile.ifc_type {
            IfcType::IfcRectangleProfileDef => self.process_rectangle(profile),
            IfcType::IfcRoundedRectangleProfileDef => self.process_rounded_rectangle(profile),
            IfcType::IfcCircleProfileDef => self.process_circle(profile),
            IfcType::IfcCircleHollowProfileDef => self.process_circle_hollow(profile),
            IfcType::IfcRectangleHollowProfileDef => self.process_rectangle_hollow(profile),
            IfcType::IfcIShapeProfileDef => self.process_i_shape(profile),
            IfcType::IfcAsymmetricIShapeProfileDef => self.process_asymmetric_i_shape(profile),
            IfcType::IfcLShapeProfileDef => self.process_l_shape(profile),
            IfcType::IfcUShapeProfileDef => self.process_u_shape(profile),
            IfcType::IfcTShapeProfileDef => self.process_t_shape(profile),
            IfcType::IfcCShapeProfileDef => self.process_c_shape(profile),
            IfcType::IfcZShapeProfileDef => self.process_z_shape(profile),
            _ => Err(Error::geometry(format!(
                "Unsupported parametric profile: {}",
                profile.ifc_type
            ))),
        }?;

        // Parameterised profiles are defined centred on their bounding box, and the
        // Position placement below is applied relative to that centred origin.
        // Several asymmetric builders (L/U/T/C) emit their points from a corner, so
        // centre every parametric profile here in one place. Already-centred shapes
        // (rectangle, circle, I, Z, …) are unaffected.
        base_profile.center_on_bbox();

        // Apply Profile Position transform (attribute 2: IfcAxis2Placement2D)
        if let Some(pos_attr) = profile.get(2) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement2D {
                        self.apply_profile_position(&mut base_profile, &pos_entity, decoder)?;
                    }
                }
            }
        }

        Ok(base_profile)
    }

    /// Apply IfcAxis2Placement2D transform to profile points
    /// IfcAxis2Placement2D: Location, RefDirection
    fn apply_profile_position(
        &self,
        profile: &mut Profile2D,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        // Get Location (attribute 0) - IfcCartesianPoint
        let (loc_x, loc_y) = if let Some(loc_attr) = placement.get(0) {
            if !loc_attr.is_null() {
                if let Some(loc_entity) = decoder.resolve_ref(loc_attr)? {
                    let coords = loc_entity
                        .get(0)
                        .and_then(|v| v.as_list())
                        .ok_or_else(|| Error::geometry("Missing point coordinates".to_string()))?;
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    (x, y)
                } else {
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        };

        // Get RefDirection (attribute 1) - IfcDirection (optional, default is (1,0))
        let (dir_x, dir_y) = if let Some(dir_attr) = placement.get(1) {
            if !dir_attr.is_null() {
                if let Some(dir_entity) = decoder.resolve_ref(dir_attr)? {
                    let ratios = dir_entity
                        .get(0)
                        .and_then(|v| v.as_list())
                        .ok_or_else(|| Error::geometry("Missing direction ratios".to_string()))?;
                    let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0);
                    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    // Normalize
                    let len = (x * x + y * y).sqrt();
                    if len > 1e-10 {
                        (x / len, y / len)
                    } else {
                        (1.0, 0.0)
                    }
                } else {
                    (1.0, 0.0)
                }
            } else {
                (1.0, 0.0)
            }
        } else {
            (1.0, 0.0)
        };

        // Skip transform if it's identity (location at origin, direction is (1,0))
        if loc_x.abs() < 1e-10
            && loc_y.abs() < 1e-10
            && (dir_x - 1.0).abs() < 1e-10
            && dir_y.abs() < 1e-10
        {
            return Ok(());
        }

        // RefDirection is the local X axis direction
        // Local Y axis is perpendicular: (-dir_y, dir_x)
        let x_axis = (dir_x, dir_y);
        let y_axis = (-dir_y, dir_x);

        // Transform all outer points
        for point in &mut profile.outer {
            let old_x = point.x;
            let old_y = point.y;
            // Rotation then translation: p' = R * p + t
            point.x = old_x * x_axis.0 + old_y * y_axis.0 + loc_x;
            point.y = old_x * x_axis.1 + old_y * y_axis.1 + loc_y;
        }

        // Transform all hole points
        for hole in &mut profile.holes {
            for point in hole {
                let old_x = point.x;
                let old_y = point.y;
                point.x = old_x * x_axis.0 + old_y * y_axis.0 + loc_x;
                point.y = old_x * x_axis.1 + old_y * y_axis.1 + loc_y;
            }
        }

        Ok(())
    }

    /// Process IfcDerivedProfileDef / IfcMirroredProfileDef.
    ///
    /// IFC4 attributes:
    ///   0: ProfileType
    ///   1: ProfileName
    ///   2: ParentProfile (IfcProfileDef)
    ///   3: Operator      (IfcCartesianTransformationOperator2D)
    ///   4: Label
    ///
    /// `IfcMirroredProfileDef` is a subtype that **always** writes `$` for
    /// the Operator attribute — the mirror is implicit about the parent
    /// profile's local Y-axis (x → −x) per IFC4. We therefore short-circuit
    /// on the subtype and only require Operator on the bare
    /// `IfcDerivedProfileDef` form.
    fn process_derived_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Profile2D> {
        let parent_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Derived profile missing ParentProfile".to_string()))?;
        let parent_profile = decoder.resolve_ref(parent_attr)?.ok_or_else(|| {
            Error::geometry("Derived profile ParentProfile not found".to_string())
        })?;

        let mut result = self.process_with_depth(&parent_profile, decoder, depth + 1)?;

        if profile.ifc_type == IfcType::IfcMirroredProfileDef {
            mirror_profile_about_y_axis(&mut result);
            return Ok(result);
        }

        // IfcDerivedProfileDef. Operator is required per the spec but some
        // authoring tools omit it when the derived profile happens to equal
        // its parent; treat null as the identity transform rather than
        // erroring (the parent already came back fully processed).
        let Some(operator_attr) = profile.get(3) else {
            return Ok(result);
        };
        if operator_attr.is_null() {
            return Ok(result);
        }
        let Some(operator) = decoder.resolve_ref(operator_attr)? else {
            return Ok(result);
        };
        self.apply_cartesian_transformation_operator_2d(&mut result, &operator, decoder)?;
        Ok(result)
    }

    /// Apply IfcCartesianTransformationOperator2D to all profile contours.
    fn apply_cartesian_transformation_operator_2d(
        &self,
        profile: &mut Profile2D,
        operator: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        let (origin_x, origin_y) = if let Some(origin_attr) = operator.get(2) {
            if let Some(origin_entity) = decoder.resolve_ref(origin_attr)? {
                let coords = origin_entity
                    .get(0)
                    .and_then(|v| v.as_list())
                    .ok_or_else(|| {
                        Error::geometry("Missing operator origin coordinates".to_string())
                    })?;
                (
                    coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                    coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                )
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        };

        let scale_x = operator.get_float(3).unwrap_or(1.0);
        let scale_y = match operator.ifc_type {
            IfcType::IfcCartesianTransformationOperator2DnonUniform => {
                operator.get_float(4).unwrap_or(scale_x)
            }
            _ => scale_x,
        };

        let axis1 = self.parse_operator_axis_2d(operator.get(0), decoder, (1.0, 0.0))?;
        let axis2 = self.parse_operator_axis_2d(operator.get(1), decoder, (0.0, 1.0))?;

        let (x_axis, y_axis) = match (axis1, axis2) {
            (Some(x_axis), Some(y_axis)) => (x_axis, y_axis),
            (Some(x_axis), None) => (x_axis, (-x_axis.1, x_axis.0)),
            (None, Some(y_axis)) => ((y_axis.1, -y_axis.0), y_axis),
            (None, None) => ((1.0, 0.0), (0.0, 1.0)),
        };

        for point in &mut profile.outer {
            let old_x = point.x;
            let old_y = point.y;
            point.x = old_x * x_axis.0 * scale_x + old_y * y_axis.0 * scale_y + origin_x;
            point.y = old_x * x_axis.1 * scale_x + old_y * y_axis.1 * scale_y + origin_y;
        }

        for hole in &mut profile.holes {
            for point in hole {
                let old_x = point.x;
                let old_y = point.y;
                point.x = old_x * x_axis.0 * scale_x + old_y * y_axis.0 * scale_y + origin_x;
                point.y = old_x * x_axis.1 * scale_x + old_y * y_axis.1 * scale_y + origin_y;
            }
        }

        // If the transformation reverses orientation (negative determinant),
        // the winding order of contours is flipped. Reverse them so that
        // extrusion normals point outward correctly.
        let det = scale_x * scale_y * (x_axis.0 * y_axis.1 - y_axis.0 * x_axis.1);
        if det < 0.0 {
            profile.outer.reverse();
            for hole in &mut profile.holes {
                hole.reverse();
            }
        }

        Ok(())
    }

    fn parse_operator_axis_2d(
        &self,
        axis_attr: Option<&AttributeValue>,
        decoder: &mut EntityDecoder,
        default: (f64, f64),
    ) -> Result<Option<(f64, f64)>> {
        let Some(axis_attr) = axis_attr else {
            return Ok(None);
        };
        if axis_attr.is_null() {
            return Ok(None);
        }

        let Some(axis_entity) = decoder.resolve_ref(axis_attr)? else {
            return Ok(None);
        };
        let ratios = axis_entity
            .get(0)
            .and_then(|v| v.as_list())
            .ok_or_else(|| Error::geometry("Missing operator axis ratios".to_string()))?;
        let x = ratios
            .first()
            .and_then(|v| v.as_float())
            .unwrap_or(default.0);
        let y = ratios
            .get(1)
            .and_then(|v| v.as_float())
            .unwrap_or(default.1);
        let len = (x * x + y * y).sqrt();
        if len <= 1e-10 {
            return Ok(Some(default));
        }

        Ok(Some((x / len, y / len)))
    }

    /// Process rectangle profile
    /// IfcRectangleProfileDef: ProfileType, ProfileName, Position, XDim, YDim
    #[inline]
    fn process_rectangle(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // Get dimensions (attributes 3 and 4)
        let x_dim = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("Rectangle missing XDim".to_string()))?;
        let y_dim = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("Rectangle missing YDim".to_string()))?;

        // Create rectangle centered at origin
        let half_x = x_dim / 2.0;
        let half_y = y_dim / 2.0;

        let points = vec![
            Point2::new(-half_x, -half_y),
            Point2::new(half_x, -half_y),
            Point2::new(half_x, half_y),
            Point2::new(-half_x, half_y),
        ];

        Ok(Profile2D::new(points))
    }

    /// Process rounded rectangle profile.
    ///
    /// IfcRoundedRectangleProfileDef: ProfileType, ProfileName, Position,
    /// XDim, YDim, RoundingRadius. Inherits from IfcRectangleProfileDef.
    /// Centered at origin; corners are arcs of `radius`, clamped to
    /// `min(XDim, YDim) / 2`. Eight segments per quadrant keeps the
    /// triangulated cap cheap while still reading as round.
    fn process_rounded_rectangle(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let x_dim = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("RoundedRectangle missing XDim".to_string()))?;
        let y_dim = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("RoundedRectangle missing YDim".to_string()))?;
        let radius = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("RoundedRectangle missing RoundingRadius".to_string()))?;

        let half_x = x_dim / 2.0;
        let half_y = y_dim / 2.0;
        let r = radius.max(0.0).min(half_x).min(half_y);
        if r < 1.0e-9 {
            return self.process_rectangle(profile);
        }

        // Reuse the shared rounded-rectangle builder (6 segments/corner at
        // Medium+, coarser below). It also dedupes seam vertices in the
        // degenerate "rounding radius == half-dim" case where the rounded
        // rectangle collapses to a circle and adjacent corner arcs share their
        // tangent point — the inline loop here used to emit duplicate points.
        Ok(Profile2D::new(rounded_rectangle_outline(
            half_x,
            half_y,
            r,
            /*ccw=*/ true,
            self.quality(),
        )))
    }

    /// Process circle profile
    /// IfcCircleProfileDef: ProfileType, ProfileName, Position, Radius
    #[inline]
    fn process_circle(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // Get radius (attribute 3)
        let radius = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("Circle missing Radius".to_string()))?;

        // 36 segments at Medium for a smooth appearance; scaled by quality.
        let segments = self.quality().circle_profile_segments(36);
        let mut points = Vec::with_capacity(segments);

        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            let x = radius * angle.cos();
            let y = radius * angle.sin();
            points.push(Point2::new(x, y));
        }

        Ok(Profile2D::new(points))
    }

    /// Process I-shape profile (simplified - basic I-beam)
    /// IfcIShapeProfileDef: ProfileType, ProfileName, Position, OverallWidth, OverallDepth, WebThickness, FlangeThickness, ...
    fn process_i_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // Get dimensions
        let overall_width = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("I-Shape missing OverallWidth".to_string()))?;
        let overall_depth = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("I-Shape missing OverallDepth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("I-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("I-Shape missing FlangeThickness".to_string()))?;

        // FilletRadius (attr 7) rounds the four web↔flange junctions (concave,
        // adds the root-fillet material). FlangeEdgeRadius (8) and FlangeSlope
        // (9) are not yet modelled (rare; absent in the ara3d set).
        let fillet = profile
            .get_float(7)
            .unwrap_or(0.0)
            .clamp(0.0, ((overall_depth - 2.0 * flange_thickness) * 0.5)
                .min((overall_width - web_thickness) * 0.5)
                .max(0.0));

        let half_width = overall_width / 2.0;
        let half_depth = overall_depth / 2.0;
        let half_web = web_thickness / 2.0;
        let ftf_bot = -half_depth + flange_thickness;
        let ftf_top = half_depth - flange_thickness;

        // Sharp outline (counter-clockwise from bottom-left). Indices 3, 4, 9,
        // 10 are the web↔flange junctions that take the fillet.
        let sharp = [
            Point2::new(-half_width, -half_depth), // 0
            Point2::new(half_width, -half_depth),  // 1
            Point2::new(half_width, ftf_bot),      // 2
            Point2::new(half_web, ftf_bot),        // 3  junction
            Point2::new(half_web, ftf_top),        // 4  junction
            Point2::new(half_width, ftf_top),      // 5
            Point2::new(half_width, half_depth),   // 6
            Point2::new(-half_width, half_depth),  // 7
            Point2::new(-half_width, ftf_top),     // 8
            Point2::new(-half_web, ftf_top),       // 9  junction
            Point2::new(-half_web, ftf_bot),       // 10 junction
            Point2::new(-half_width, ftf_bot),     // 11
        ];
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        // Indices 3, 4, 9, 10 are the four web↔flange junctions.
        let radii = [(3, fillet), (4, fillet), (9, fillet), (10, fillet)];
        Ok(Profile2D::new(fillet_outline(&sharp, &radii, seg)))
    }

    /// Process asymmetric I-shape profile.
    ///
    /// `IfcAsymmetricIShapeProfileDef` (IFC4) attributes after the three
    /// inherited `IfcParameterizedProfileDef` slots (ProfileType,
    /// ProfileName, Position):
    ///
    ///   3:  BottomFlangeWidth          (required)
    ///   4:  OverallDepth               (required)
    ///   5:  WebThickness               (required)
    ///   6:  BottomFlangeThickness      (required)
    ///   7:  BottomFlangeFilletRadius   (optional, ignored — see below)
    ///   8:  TopFlangeWidth             (required)
    ///   9:  TopFlangeThickness         (optional, falls back to BottomFlangeThickness)
    ///   10: TopFlangeFilletRadius      (optional, ignored)
    ///   11: BottomFlangeEdgeRadius     (optional, ignored)
    ///   12: BottomFlangeSlope          (optional, ignored)
    ///   13: TopFlangeEdgeRadius        (optional, ignored)
    ///   14: TopFlangeSlope             (optional, ignored)
    ///
    /// Fillet radii / edge tapers / slopes are intentionally omitted: the
    /// existing symmetric `process_i_shape` ignores them too and the bridge
    /// fixture in issue #828 doesn't need them to read correctly.
    /// `process_i_shape` ignores them too. The origin sits at the centre
    /// of the bounding rectangle (`max(top_width, bottom_width)` by
    /// `overall_depth`) — same convention as the symmetric variant, which
    /// is what Tekla, Revit, and the IfcOpenShell reference impl all emit.
    fn process_asymmetric_i_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let bottom_width = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("AsymmetricI missing BottomFlangeWidth".to_string()))?;
        let overall_depth = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("AsymmetricI missing OverallDepth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("AsymmetricI missing WebThickness".to_string()))?;
        let bottom_flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("AsymmetricI missing BottomFlangeThickness".to_string()))?;
        let top_width = profile
            .get_float(8)
            .ok_or_else(|| Error::geometry("AsymmetricI missing TopFlangeWidth".to_string()))?;
        // TopFlangeThickness is OPTIONAL in IFC4. When omitted, the IFC4
        // schema rule `IfcAsymmetricIShapeProfileDef.WR3` says the value
        // equals BottomFlangeThickness — so symmetric flange thicknesses
        // can be authored by leaving the top one $.
        let top_flange_thickness = profile.get_float(9).unwrap_or(bottom_flange_thickness);

        if overall_depth <= bottom_flange_thickness + top_flange_thickness {
            return Err(Error::geometry(format!(
                "AsymmetricI: OverallDepth {} must exceed BottomFlangeThickness + \
                 TopFlangeThickness ({} + {} = {})",
                overall_depth,
                bottom_flange_thickness,
                top_flange_thickness,
                bottom_flange_thickness + top_flange_thickness,
            )));
        }

        let half_overall_width = bottom_width.max(top_width) * 0.5;
        let half_depth = overall_depth * 0.5;
        let half_web = web_thickness * 0.5;
        let half_bottom = bottom_width * 0.5;
        let half_top = top_width * 0.5;

        // Twelve-point CCW outline starting at the bottom-flange's
        // bottom-left corner. Identical topology to `process_i_shape` but
        // with two independent flange widths. The point at `(_, -half_depth
        // + bottom_flange_thickness)` is intentionally placed at the
        // bottom-flange edge (`±half_bottom`) — *not* at the overall width
        // — so a wider bottom flange protrudes correctly.
        let _ = half_overall_width; // (kept for future fillet/slope work)
        let points = vec![
            Point2::new(-half_bottom, -half_depth),
            Point2::new(half_bottom, -half_depth),
            Point2::new(half_bottom, -half_depth + bottom_flange_thickness),
            Point2::new(half_web, -half_depth + bottom_flange_thickness),
            Point2::new(half_web, half_depth - top_flange_thickness),
            Point2::new(half_top, half_depth - top_flange_thickness),
            Point2::new(half_top, half_depth),
            Point2::new(-half_top, half_depth),
            Point2::new(-half_top, half_depth - top_flange_thickness),
            Point2::new(-half_web, half_depth - top_flange_thickness),
            Point2::new(-half_web, -half_depth + bottom_flange_thickness),
            Point2::new(-half_bottom, -half_depth + bottom_flange_thickness),
        ];

        Ok(Profile2D::new(points))
    }

    /// Process circle hollow profile (tube/pipe)
    /// IfcCircleHollowProfileDef: ProfileType, ProfileName, Position, Radius, WallThickness
    fn process_circle_hollow(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let radius = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("CircleHollow missing Radius".to_string()))?;
        let wall_thickness = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("CircleHollow missing WallThickness".to_string()))?;

        let inner_radius = radius - wall_thickness;
        let segments = self.quality().circle_profile_segments(36);

        // Outer circle
        let mut outer_points = Vec::with_capacity(segments);
        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            outer_points.push(Point2::new(radius * angle.cos(), radius * angle.sin()));
        }

        // Inner circle (reversed for hole)
        let mut inner_points = Vec::with_capacity(segments);
        for i in (0..segments).rev() {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            inner_points.push(Point2::new(
                inner_radius * angle.cos(),
                inner_radius * angle.sin(),
            ));
        }

        let mut result = Profile2D::new(outer_points);
        result.add_hole(inner_points);
        Ok(result)
    }

    /// Process rectangle hollow profile (rectangular tube)
    /// IfcRectangleHollowProfileDef: ProfileType, ProfileName, Position, XDim, YDim, WallThickness, InnerFilletRadius, OuterFilletRadius
    ///
    /// Both fillet radii are optional in the schema. When set, they replace the
    /// sharp 90° corners with quarter-circle arcs:
    ///
    /// * `OuterFilletRadius = R_o` rounds each outer corner with radius R_o.
    /// * `InnerFilletRadius = R_i` rounds the corresponding inner corner. When
    ///   `R_i == min(inner_half_x, inner_half_y)` the four inner arcs meet and
    ///   the inner hole degenerates to a circle (issue #854 — RHS with a thin
    ///   wall and circular bore, common for HVAC diffusers).
    ///
    /// The standard requires `R_o >= R_i + WallThickness` for a uniform-thickness
    /// shell, but BIM authoring tools sometimes violate that; we tessellate
    /// whatever radii were authored and let the renderer show the result.
    fn process_rectangle_hollow(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let x_dim = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("RectangleHollow missing XDim".to_string()))?;
        let y_dim = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("RectangleHollow missing YDim".to_string()))?;
        let wall_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("RectangleHollow missing WallThickness".to_string()))?;

        let half_x = x_dim / 2.0;
        let half_y = y_dim / 2.0;

        // Validate wall thickness
        if wall_thickness >= half_x || wall_thickness >= half_y {
            return Err(Error::geometry(format!(
                "RectangleHollow WallThickness {} exceeds half dimensions ({}, {})",
                wall_thickness, half_x, half_y
            )));
        }

        let inner_half_x = half_x - wall_thickness;
        let inner_half_y = half_y - wall_thickness;

        // InnerFilletRadius is attr 6, OuterFilletRadius is attr 7. Both
        // optional; `None` (or a value below 1 µm) collapses to sharp
        // corners. Clamp to the half-extent so an authored value larger
        // than the inner half-dim doesn't fold the polygon inside-out.
        let inner_fillet = profile
            .get_float(6)
            .unwrap_or(0.0)
            .max(0.0)
            .min(inner_half_x)
            .min(inner_half_y);
        let outer_fillet = profile
            .get_float(7)
            .unwrap_or(0.0)
            .max(0.0)
            .min(half_x)
            .min(half_y);

        let q = self.quality();
        let outer_points =
            rounded_rectangle_outline(half_x, half_y, outer_fillet, /*ccw=*/ true, q);
        let inner_points =
            rounded_rectangle_outline(inner_half_x, inner_half_y, inner_fillet, /*ccw=*/ false, q);

        let mut result = Profile2D::new(outer_points);
        result.add_hole(inner_points);
        Ok(result)
    }

    /// Process L-shape profile (angle)
    /// IfcLShapeProfileDef: ProfileType, ProfileName, Position, Depth, Width, Thickness, ...
    fn process_l_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // IfcLShapeProfileDef: Depth(3), Width(4), Thickness(5), FilletRadius(6),
        // EdgeRadius(7), LegSlope(8). Built corner-at-origin (heel at (0,0),
        // horizontal leg along +X, vertical leg along +Y); `center_on_bbox`
        // re-centres it. LegSlope (tapered legs) is rare and not modelled.
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("L-Shape missing Depth".to_string()))?;
        let width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("L-Shape missing Width".to_string()))?;
        let t = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("L-Shape missing Thickness".to_string()))?;

        // FilletRadius rounds the inner re-entrant corner (concave, adds
        // material); EdgeRadius rounds the two leg toes (convex, removes the
        // sharp tips). Both optional; clamp so the arcs stay inside the legs.
        let rf = profile
            .get_float(6)
            .unwrap_or(0.0)
            .clamp(0.0, (width - t).min(depth - t).max(0.0));
        let re = profile.get_float(7).unwrap_or(0.0).clamp(0.0, t * 0.999);
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        let half_pi = std::f64::consts::FRAC_PI_2;
        let pi = std::f64::consts::PI;

        // Counter-clockwise from the heel.
        let mut p: Vec<Point2<f64>> = Vec::new();
        p.push(Point2::new(0.0, 0.0)); // heel (outer corner) — sharp
        p.push(Point2::new(width, 0.0)); // horizontal leg outer end — sharp
        // horizontal leg toe (width, t): convex EdgeRadius
        if re > 1.0e-9 {
            push_arc(&mut p, width - re, t - re, re, 0.0, half_pi, seg);
        } else {
            p.push(Point2::new(width, t));
        }
        // inner re-entrant corner (t, t): concave FilletRadius
        if rf > 1.0e-9 {
            push_arc(&mut p, t + rf, t + rf, rf, 1.5 * pi, pi, seg);
        } else {
            p.push(Point2::new(t, t));
        }
        // vertical leg toe (t, depth): convex EdgeRadius
        if re > 1.0e-9 {
            push_arc(&mut p, t - re, depth - re, re, 0.0, half_pi, seg);
        } else {
            p.push(Point2::new(t, depth));
        }
        p.push(Point2::new(0.0, depth)); // vertical leg outer end — sharp

        Ok(Profile2D::new(p))
    }

    /// Process U-shape profile (channel)
    /// IfcUShapeProfileDef: ProfileType, ProfileName, Position, Depth, FlangeWidth, WebThickness, FlangeThickness, ...
    fn process_u_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("U-Shape missing Depth".to_string()))?;
        let flange_width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("U-Shape missing FlangeWidth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("U-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("U-Shape missing FlangeThickness".to_string()))?;

        // FilletRadius (attr 7) rounds the two inner web↔flange junctions
        // (concave); EdgeRadius (attr 8) rounds the two flange toes (convex).
        // FlangeSlope (9) not modelled.
        let half_depth = depth / 2.0;
        let ft = flange_thickness;
        let rf = profile
            .get_float(7)
            .unwrap_or(0.0)
            .clamp(0.0, (flange_width - web_thickness).min(half_depth - ft).max(0.0));
        let re = profile.get_float(8).unwrap_or(0.0).clamp(0.0, ft * 0.999);

        // Sharp outline (counter-clockwise). 2,5 = flange toes; 3,4 = junctions.
        let sharp = [
            Point2::new(0.0, -half_depth),               // 0 back-bottom outer
            Point2::new(flange_width, -half_depth),       // 1 bottom toe outer
            Point2::new(flange_width, -half_depth + ft),  // 2 bottom toe inner (edge)
            Point2::new(web_thickness, -half_depth + ft), // 3 bottom junction (fillet)
            Point2::new(web_thickness, half_depth - ft),  // 4 top junction (fillet)
            Point2::new(flange_width, half_depth - ft),   // 5 top toe inner (edge)
            Point2::new(flange_width, half_depth),        // 6 top toe outer
            Point2::new(0.0, half_depth),                 // 7 back-top outer
        ];
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        let radii = [(2, re), (3, rf), (4, rf), (5, re)];
        Ok(Profile2D::new(fillet_outline(&sharp, &radii, seg)))
    }

    /// Process T-shape profile
    /// IfcTShapeProfileDef: ProfileType, ProfileName, Position, Depth, FlangeWidth, WebThickness, FlangeThickness, ...
    fn process_t_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("T-Shape missing Depth".to_string()))?;
        let flange_width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("T-Shape missing FlangeWidth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("T-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("T-Shape missing FlangeThickness".to_string()))?;

        // FilletRadius (attr 7) rounds the two web↔flange junctions (concave);
        // FlangeEdgeRadius (8) rounds the flange toes; WebEdgeRadius (9) rounds
        // the web's free end. Flange/Web slopes (10/11) not modelled.
        let half_flange = flange_width / 2.0;
        let half_web = web_thickness / 2.0;
        let ft = flange_thickness;
        let ftf = depth - ft; // flange inner face Y
        let rf = profile
            .get_float(7)
            .unwrap_or(0.0)
            .clamp(0.0, (half_flange - half_web).min(ftf).max(0.0));
        let r_fl = profile.get_float(8).unwrap_or(0.0).clamp(0.0, ft * 0.999);
        let r_web = profile.get_float(9).unwrap_or(0.0).clamp(0.0, half_web * 0.999);

        // Sharp outline (counter-clockwise). 1,6 = junctions; 2,5 = flange toes;
        // 0,7 = web free-end corners.
        let sharp = [
            Point2::new(-half_web, 0.0),       // 0 web bottom-left (web edge)
            Point2::new(-half_web, ftf),       // 1 left junction (fillet)
            Point2::new(-half_flange, ftf),    // 2 flange left toe inner (flange edge)
            Point2::new(-half_flange, depth),  // 3 flange left toe top
            Point2::new(half_flange, depth),   // 4 flange right toe top
            Point2::new(half_flange, ftf),     // 5 flange right toe inner (flange edge)
            Point2::new(half_web, ftf),        // 6 right junction (fillet)
            Point2::new(half_web, 0.0),        // 7 web bottom-right (web edge)
        ];
        // Root-fillet segments per corner: 6 at Medium+, coarser below.
        let seg = self.quality().profile_arc_segments(6, 2);
        let radii = [
            (0, r_web),
            (1, rf),
            (2, r_fl),
            (5, r_fl),
            (6, rf),
            (7, r_web),
        ];
        Ok(Profile2D::new(fillet_outline(&sharp, &radii, seg)))
    }

    /// Process C-shape profile (channel with lips)
    /// IfcCShapeProfileDef: ProfileType, ProfileName, Position, Depth, Width, WallThickness, Girth, ...
    fn process_c_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        // IfcCShapeProfileDef: Depth(3), Width(4), WallThickness(5), Girth(6),
        // InternalFilletRadius(7). A lipped channel symmetric about its X-axis:
        // a web on the left, top/bottom flanges spanning the full Width, and
        // return lips of length Girth at the flange tips.
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("C-Shape missing Depth".to_string()))?;
        let width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("C-Shape missing Width".to_string()))?;
        let wall_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("C-Shape missing WallThickness".to_string()))?;
        let girth = profile.get_float(6).unwrap_or(wall_thickness * 2.0); // Lip length

        let half_depth = depth / 2.0;
        let t = wall_thickness;

        // Counter-clockwise outline. Previously this used `girth` as the X
        // extent and dropped `width` entirely, so the channel came out only
        // ~girth wide (a few × the thickness) instead of its full Width. The
        // flanges now span [0, Width]; the lips turn inward by Girth at x=Width.
        let points = vec![
            Point2::new(0.0, -half_depth),                  // bottom-left outer
            Point2::new(width, -half_depth),                // bottom-right outer
            Point2::new(width, -half_depth + girth),        // bottom lip tip
            Point2::new(width - t, -half_depth + girth),    // bottom lip inner
            Point2::new(width - t, -half_depth + t),        // bottom flange inner
            Point2::new(t, -half_depth + t),                // web inner bottom
            Point2::new(t, half_depth - t),                 // web inner top
            Point2::new(width - t, half_depth - t),         // top flange inner
            Point2::new(width - t, half_depth - girth),     // top lip inner
            Point2::new(width, half_depth - girth),         // top lip tip
            Point2::new(width, half_depth),                 // top-right outer
            Point2::new(0.0, half_depth),                   // top-left outer
        ];

        Ok(Profile2D::new(points))
    }

    /// Process Z-shape profile
    /// IfcZShapeProfileDef: ProfileType, ProfileName, Position, Depth, FlangeWidth, WebThickness, FlangeThickness, ...
    fn process_z_shape(&self, profile: &DecodedEntity) -> Result<Profile2D> {
        let depth = profile
            .get_float(3)
            .ok_or_else(|| Error::geometry("Z-Shape missing Depth".to_string()))?;
        let flange_width = profile
            .get_float(4)
            .ok_or_else(|| Error::geometry("Z-Shape missing FlangeWidth".to_string()))?;
        let web_thickness = profile
            .get_float(5)
            .ok_or_else(|| Error::geometry("Z-Shape missing WebThickness".to_string()))?;
        let flange_thickness = profile
            .get_float(6)
            .ok_or_else(|| Error::geometry("Z-Shape missing FlangeThickness".to_string()))?;

        let half_depth = depth / 2.0;
        let half_web = web_thickness / 2.0;

        // Z-shape profile (counter-clockwise)
        let points = vec![
            Point2::new(-half_web, -half_depth),
            Point2::new(-half_web - flange_width, -half_depth),
            Point2::new(-half_web - flange_width, -half_depth + flange_thickness),
            Point2::new(-half_web, -half_depth + flange_thickness),
            Point2::new(-half_web, half_depth - flange_thickness),
            Point2::new(half_web, half_depth - flange_thickness),
            Point2::new(half_web, half_depth),
            Point2::new(half_web + flange_width, half_depth),
            Point2::new(half_web + flange_width, half_depth - flange_thickness),
            Point2::new(half_web, half_depth - flange_thickness),
            Point2::new(half_web, -half_depth + flange_thickness),
            Point2::new(-half_web, -half_depth + flange_thickness),
        ];

        Ok(Profile2D::new(points))
    }

    /// Process arbitrary closed profile (polyline-based)
    /// IfcArbitraryClosedProfileDef: ProfileType, ProfileName, OuterCurve
    /// IfcArbitraryProfileDefWithVoids: ProfileType, ProfileName, OuterCurve, InnerCurves
    fn process_arbitrary(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Profile2D> {
        // Get outer curve (attribute 2)
        let curve_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Arbitrary profile missing OuterCurve".to_string()))?;

        let curve = decoder
            .resolve_ref(curve_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve OuterCurve".to_string()))?;

        // Process outer curve
        let raw_outer = self.process_curve(&curve, decoder)?;
        // Issue #635 — downsample over-tessellated smooth curves so that
        // round/curved openings produce extrusions small enough to fit in
        // the BSP CSG polygon budget and hence get a real polygon-shaped
        // cut instead of the AABB rectangular fallback.
        let outer_points = simplify_smooth_curve_polyline(&raw_outer);
        let mut result = Profile2D::new(outer_points);

        // Check if this is IfcArbitraryProfileDefWithVoids (has inner curves)
        if profile.ifc_type == IfcType::IfcArbitraryProfileDefWithVoids {
            // Get inner curves list (attribute 3)
            if let Some(inner_curves_attr) = profile.get(3) {
                let inner_curves = decoder.resolve_ref_list(inner_curves_attr)?;
                for inner_curve in inner_curves {
                    let raw_hole = self.process_curve(&inner_curve, decoder)?;
                    let hole_points = simplify_smooth_curve_polyline(&raw_hole);
                    result.add_hole(hole_points);
                }
            }
        }

        Ok(result)
    }

    /// Process any supported curve type into 2D points
    #[inline]
    fn process_curve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        self.process_curve_with_depth(curve, decoder, 0)
    }

    /// Process curve with depth tracking to prevent stack overflow
    fn process_curve_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point2<f64>>> {
        if depth > MAX_CURVE_DEPTH {
            return Err(Error::geometry(format!(
                "Curve nesting depth {} exceeds limit {}",
                depth, MAX_CURVE_DEPTH
            )));
        }
        match curve.ifc_type {
            IfcType::IfcPolyline => self.process_polyline(curve, decoder),
            IfcType::IfcIndexedPolyCurve => self.process_indexed_polycurve(curve, decoder),
            IfcType::IfcCompositeCurve => {
                self.process_composite_curve_with_depth(curve, decoder, depth)
            }
            IfcType::IfcTrimmedCurve => {
                self.process_trimmed_curve_with_depth(curve, decoder, depth)
            }
            IfcType::IfcCircle => self.process_circle_curve(curve, decoder),
            IfcType::IfcEllipse => self.process_ellipse_curve(curve, decoder),
            _ => Err(Error::geometry(format!(
                "Unsupported curve type: {}",
                curve.ifc_type
            ))),
        }
    }

    /// Get 3D points from a curve (for swept disk solid, etc.) at the given
    /// tessellation `quality`.
    #[inline]
    pub fn get_curve_points(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Vec<Point3<f64>>> {
        self.active_quality.set(quality);
        self.get_curve_points_with_depth(curve, decoder, 0)
    }

    /// Get 3D curve points with depth tracking to prevent stack overflow
    fn get_curve_points_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point3<f64>>> {
        if depth > MAX_CURVE_DEPTH {
            return Err(Error::geometry(format!(
                "Curve nesting depth {} exceeds limit {}",
                depth, MAX_CURVE_DEPTH
            )));
        }
        match curve.ifc_type {
            IfcType::IfcPolyline => self.process_polyline_3d(curve, decoder),
            IfcType::IfcCompositeCurve => {
                self.process_composite_curve_3d_with_depth(curve, decoder, depth)
            }
            // IFC4x3 IfcGradientCurve = IfcCompositeCurve subtype that adds a
            // 2D BaseCurve (attr 2) supplying the horizontal layout + own
            // segments supplying the vertical (z) profile. The minimum-viable
            // sampler for #859's IfcLinearPlacement use case returns the
            // horizontal track of points by recursing into BaseCurve and
            // dropping Z to 0 — every signal lands at the correct (x, y)
            // station, just at the alignment's reference elevation instead
            // of the true grade-corrected z. Full grade evaluation is a
            // follow-up; "every signal pinned to its alignment station" is
            // already a vast improvement over the pre-fix "all signals at
            // world origin" state.
            IfcType::IfcGradientCurve => {
                if let Some(base_attr) = curve.get(2) {
                    if !base_attr.is_null() {
                        if let Some(base) = decoder.resolve_ref(base_attr)? {
                            return self.get_curve_points_with_depth(&base, decoder, depth + 1);
                        }
                    }
                }
                // No BaseCurve → fall through to the segments-as-composite path
                // so we at least produce something rather than erroring.
                self.process_composite_curve_3d_with_depth(curve, decoder, depth)
            }
            IfcType::IfcCircle => self.process_circle_3d(curve, decoder),
            IfcType::IfcIndexedPolyCurve => {
                // Native 3D path: handles both IfcCartesianPointList2D (z=0) and
                // IfcCartesianPointList3D, and fits arc segments in the plane of
                // their three control points. Falling through to the 2D fallback
                // would drop the Z coordinate of every 3D point list (issue #631
                // stirrup case).
                self.process_indexed_polycurve_3d(curve, decoder)
            }
            IfcType::IfcTrimmedCurve => {
                // For trimmed curve, get 2D points and convert to 3D
                let points_2d = self.process_trimmed_curve_with_depth(curve, decoder, depth)?;
                Ok(points_2d
                    .into_iter()
                    .map(|p| Point3::new(p.x, p.y, 0.0))
                    .collect())
            }
            _ => {
                // Fallback: try 2D curve and convert to 3D
                let points_2d = self.process_curve_with_depth(curve, decoder, depth)?;
                Ok(points_2d
                    .into_iter()
                    .map(|p| Point3::new(p.x, p.y, 0.0))
                    .collect())
            }
        }
    }

    /// Process circle curve in 3D space (for swept disk solid, etc.)
    fn process_circle_3d(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        // IfcCircle: Position (IfcAxis2Placement2D or 3D), Radius
        let position_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("Circle missing Position".to_string()))?;

        let radius = curve
            .get_float(1)
            .ok_or_else(|| Error::geometry("Circle missing Radius".to_string()))?;

        let position = decoder
            .resolve_ref(position_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve circle position".to_string()))?;

        // Get center and orientation from Axis2Placement3D
        let (center, x_axis, y_axis) = if position.ifc_type == IfcType::IfcAxis2Placement3D {
            // IfcAxis2Placement3D: Location, Axis (Z), RefDirection (X)
            let loc_attr = position
                .get(0)
                .ok_or_else(|| Error::geometry("Axis2Placement3D missing Location".to_string()))?;
            let loc = decoder
                .resolve_ref(loc_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve location".to_string()))?;
            let coords = loc
                .get(0)
                .and_then(|v| v.as_list())
                .ok_or_else(|| Error::geometry("Location missing coordinates".to_string()))?;
            let center = Point3::new(
                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
            );

            // Get Z axis (Axis attribute)
            let z_axis = if let Some(axis_attr) = position.get(1) {
                if !axis_attr.is_null() {
                    let axis = decoder.resolve_ref(axis_attr)?;
                    if let Some(axis) = axis {
                        let coords = axis.get(0).and_then(|v| v.as_list());
                        if let Some(coords) = coords {
                            Vector3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(1.0),
                            )
                            .normalize()
                        } else {
                            Vector3::new(0.0, 0.0, 1.0)
                        }
                    } else {
                        Vector3::new(0.0, 0.0, 1.0)
                    }
                } else {
                    Vector3::new(0.0, 0.0, 1.0)
                }
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            };

            // Get X axis (RefDirection attribute)
            let x_axis = if let Some(ref_attr) = position.get(2) {
                if !ref_attr.is_null() {
                    let ref_dir = decoder.resolve_ref(ref_attr)?;
                    if let Some(ref_dir) = ref_dir {
                        let coords = ref_dir.get(0).and_then(|v| v.as_list());
                        if let Some(coords) = coords {
                            Vector3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(1.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                            )
                            .normalize()
                        } else {
                            Vector3::new(1.0, 0.0, 0.0)
                        }
                    } else {
                        Vector3::new(1.0, 0.0, 0.0)
                    }
                } else {
                    Vector3::new(1.0, 0.0, 0.0)
                }
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            };

            // Y axis = Z cross X
            let y_axis = z_axis.cross(&x_axis).normalize();

            (center, x_axis, y_axis)
        } else {
            // 2D placement - use XY plane
            let loc_attr = position.get(0);
            let (cx, cy) = if let Some(attr) = loc_attr {
                let loc = decoder.resolve_ref(attr)?;
                if let Some(loc) = loc {
                    let coords = loc.get(0).and_then(|v| v.as_list());
                    if let Some(coords) = coords {
                        (
                            coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                            coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                        )
                    } else {
                        (0.0, 0.0)
                    }
                } else {
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            };
            (
                Point3::new(cx, cy, 0.0),
                Vector3::new(1.0, 0.0, 0.0),
                Vector3::new(0.0, 1.0, 0.0),
            )
        };

        // Generate circle points in 3D (24 at Medium, scaled by quality)
        let segments = scale_segments(24, 8, 96, self.quality());
        let mut points = Vec::with_capacity(segments + 1);

        for i in 0..=segments {
            let angle = 2.0 * std::f64::consts::PI * i as f64 / segments as f64;
            let p = center + x_axis * (radius * angle.cos()) + y_axis * (radius * angle.sin());
            points.push(p);
        }

        Ok(points)
    }

    /// Process polyline into 3D points
    fn process_polyline_3d(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        // IfcPolyline: Points
        let points_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("Polyline missing Points".to_string()))?;

        let points = decoder.resolve_ref_list(points_attr)?;
        let mut result = Vec::with_capacity(points.len());

        for point in points {
            // IfcCartesianPoint: Coordinates
            let coords_attr = point
                .get(0)
                .ok_or_else(|| Error::geometry("CartesianPoint missing Coordinates".to_string()))?;

            let coords = coords_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Coordinates is not a list".to_string()))?;

            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

            result.push(Point3::new(x, y, z));
        }

        Ok(result)
    }

    /// Process composite curve into 3D points
    fn process_composite_curve_3d_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point3<f64>>> {
        // IfcCompositeCurve: Segments, SelfIntersect
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;

        let segments = decoder.resolve_ref_list(segments_attr)?;
        let mut result = Vec::new();
        // Track the last IfcCurveSegment we sampled so we can extrapolate its
        // terminal point after the loop. Each segment in the loop body emits
        // only its START placement; without the terminal, every product whose
        // `DistanceAlong` falls inside the FINAL segment after its start
        // station gets clamped by `sample_polyline_at_distance` to that
        // segment's start (i.e. authored station 800 instead of 900 on a
        // 932-m alignment with the last segment spanning 800..932). See the
        // post-loop block below.
        let mut last_curve_segment_terminal: Option<Point3<f64>> = None;

        for segment in segments {
            // IFC4x3 IfcCurveSegment (alignment fixtures) has a different
            // attribute layout from the IFC2x3/IFC4 IfcCompositeCurveSegment
            // the original walker was written for:
            //   IfcCurveSegment: 0 Transition, 1 Placement (IfcAxis2Placement2D/3D),
            //                    2 SegmentStart (length measure), 3 SegmentLength,
            //                    4 ParentCurve
            // Without recognising it, every alignment-authored composite
            // curve errored out at "Failed to resolve ParentCurve" (the old
            // walker reading attr 2 hit the SegmentStart length measure),
            // which broke #859's IfcLinearPlacement resolver — every
            // linearly-placed signal/referent fell back to identity.
            //
            // Minimum-viable handling: emit the segment's Placement.Location
            // as ONE sample point and let the linear-placement sampler
            // interpolate linearly between segment starts. Sparse but
            // already a vast improvement over "all at origin". A full
            // alignment evaluator (sampling the ParentCurve inside each
            // segment's authored start..start+length range) is follow-up
            // scope.
            if segment.ifc_type == IfcType::IfcCurveSegment {
                if let Some(placement_attr) = segment.get(1) {
                    if !placement_attr.is_null() {
                        if let Some(placement) = decoder.resolve_ref(placement_attr)? {
                            if let Some((origin, x_axis)) =
                                axis2_placement_location_and_x_axis_3d(&placement, decoder)
                            {
                                if result.last().map_or(true, |last: &Point3<f64>| {
                                    (last - origin).norm() > 1e-9
                                }) {
                                    result.push(origin);
                                }
                                // Stash the segment's projected terminal in
                                // case this turns out to be the last segment.
                                // Read SegmentLength (attr 3); the value may
                                // be wrapped in an IfcLengthMeasure typed
                                // record or be a bare REAL.
                                let segment_length = segment
                                    .get(3)
                                    .and_then(|a| a.as_float())
                                    .unwrap_or(0.0);
                                if segment_length > 1e-9 {
                                    last_curve_segment_terminal =
                                        Some(origin + x_axis * segment_length);
                                } else {
                                    last_curve_segment_terminal = None;
                                }
                                continue;
                            }
                        }
                    }
                }
                // Couldn't read this segment's placement — skip rather than fail.
                last_curve_segment_terminal = None;
                continue;
            }
            // Non-IfcCurveSegment branch (IfcCompositeCurveSegment): the
            // explicit ParentCurve samples below already give us the segment
            // end, so clear the stashed terminal.
            last_curve_segment_terminal = None;

            // IfcCompositeCurveSegment: Transition, SameSense, ParentCurve
            let parent_curve_attr = segment.get(2).ok_or_else(|| {
                Error::geometry("CompositeCurveSegment missing ParentCurve".to_string())
            })?;

            let parent_curve = decoder
                .resolve_ref(parent_curve_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve ParentCurve".to_string()))?;

            // Get same_sense for direction
            let same_sense = segment
                .get(1)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str()),
                    _ => None,
                })
                .map(|e| e == "T" || e == "TRUE")
                .unwrap_or(true);

            let mut segment_points =
                self.get_curve_points_with_depth(&parent_curve, decoder, depth + 1)?;

            if !same_sense {
                segment_points.reverse();
            }

            // Skip first point if we already have points (avoid duplicates)
            if !result.is_empty() && !segment_points.is_empty() {
                result.extend(segment_points.into_iter().skip(1));
            } else {
                result.extend(segment_points);
            }
        }

        // Append the last IfcCurveSegment's terminal sample (exact for
        // straight segments, tangent approximation for curves). Pre-fix the
        // missing terminal made `sample_polyline_at_distance` clamp any
        // product in the final segment to the segment's start station; this
        // surfaces visibly as railway signals authored at station 900 m
        // snapping onto the segment-start marker around station 800 m.
        if let Some(terminal) = last_curve_segment_terminal {
            if result.last().map_or(true, |last: &Point3<f64>| {
                (last - terminal).norm() > 1e-9
            }) {
                result.push(terminal);
            }
        }

        Ok(result)
    }

    /// Process composite curve into 3D points, honoring `IfcSweptDiskSolid`'s
    /// `StartParam`/`EndParam`. Per IFC, a composite curve is parameterised so
    /// segment `i` covers `[i, i+1]`. Segments fully outside `[start, end]` are
    /// dropped; boundary segments are truncated by linearly interpolating along
    /// their sampled point list (a per-segment normalised parameter).
    ///
    /// Non-conformant out-of-range `EndParam` values (notably Revit, which
    /// emits a cumulative-per-segment parameter that can exceed `num_segments`)
    /// are clamped to the upper bound of the spec domain — this matches the
    /// authoring tool's effective intent (render the whole curve) without
    /// guessing at a length-unit interpretation that proved wrong on real
    /// files (see #631 follow-up notes).
    pub fn get_composite_curve_points_trimmed(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start_param: Option<f64>,
        end_param: Option<f64>,
    ) -> Result<Vec<Point3<f64>>> {
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;
        let segments = decoder.resolve_ref_list(segments_attr)?;
        let num_segments = segments.len();
        if num_segments == 0 {
            return Ok(Vec::new());
        }

        let start = start_param.unwrap_or(0.0).max(0.0);
        let end = end_param.unwrap_or(num_segments as f64).min(num_segments as f64);
        if end <= start {
            return Ok(Vec::new());
        }

        let mut result: Vec<Point3<f64>> = Vec::new();
        for (idx, segment) in segments.into_iter().enumerate() {
            let seg_start = idx as f64;
            let seg_end = seg_start + 1.0;
            // Skip segments fully outside the trim window
            if seg_end <= start || seg_start >= end {
                continue;
            }

            let parent_curve_attr = segment.get(2).ok_or_else(|| {
                Error::geometry("CompositeCurveSegment missing ParentCurve".to_string())
            })?;
            let parent_curve = decoder
                .resolve_ref(parent_curve_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve ParentCurve".to_string()))?;
            let same_sense = segment
                .get(1)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str()),
                    _ => None,
                })
                .map(|e| e == "T" || e == "TRUE")
                .unwrap_or(true);

            let mut seg_points = self.get_curve_points_with_depth(&parent_curve, decoder, 1)?;
            if !same_sense {
                seg_points.reverse();
            }
            if seg_points.len() < 2 {
                continue;
            }

            // Map global trim window to this segment's local [0,1] domain
            let local_start = (start - seg_start).clamp(0.0, 1.0);
            let local_end = (end - seg_start).clamp(0.0, 1.0);
            if local_end <= local_start {
                continue;
            }

            let trimmed = if local_start == 0.0 && local_end == 1.0 {
                seg_points
            } else {
                trim_polyline(&seg_points, local_start, local_end)
            };

            if trimmed.is_empty() {
                continue;
            }
            // Drop the first point of the next segment ONLY when it coincides with
            // the last point already in `result` — i.e. the segments share their
            // junction vertex and concatenating verbatim would duplicate it.
            // Composite curves whose adjacent segments are not coordinate-identical
            // at the boundary (e.g. floating-point drift, or segments stitched
            // together at deliberately distinct points) must keep the first vertex
            // or the directrix gets distorted.
            const JUNCTION_EPS: f64 = 1e-6;
            let mut iter = trimmed.into_iter();
            if let Some(first) = iter.next() {
                let coincident = result.last().map_or(false, |last| {
                    (first.x - last.x).abs() < JUNCTION_EPS
                        && (first.y - last.y).abs() < JUNCTION_EPS
                        && (first.z - last.z).abs() < JUNCTION_EPS
                });
                if !coincident {
                    result.push(first);
                }
                result.extend(iter);
            }
        }

        Ok(result)
    }

    /// Sample an `IfcPolyline` directrix and trim by parameter range.
    /// IFC parameterises a polyline as `[0, N-1]` where `N` is the number of points
    /// and each segment between consecutive points contributes 1.0 to the parameter.
    /// `StartParam` / `EndParam` are converted to a fraction of the polyline and
    /// `trim_polyline` does the actual cutting (linear interpolation between sampled
    /// vertices, which is exact for piecewise-linear input).
    pub fn get_polyline_points_trimmed(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start_param: Option<f64>,
        end_param: Option<f64>,
    ) -> Result<Vec<Point3<f64>>> {
        let points = self.process_polyline_3d(curve, decoder)?;
        if points.len() < 2 {
            return Ok(points);
        }
        let max_param = (points.len() - 1) as f64;
        let s = start_param.unwrap_or(0.0).clamp(0.0, max_param);
        let e = end_param.unwrap_or(max_param).clamp(0.0, max_param);
        if e <= s {
            return Ok(Vec::new());
        }
        // Convert IFC parameter (0..N-1) to trim_polyline's local [0,1] domain
        Ok(trim_polyline(&points, s / max_param, e / max_param))
    }

    /// Process trimmed curve
    /// IfcTrimmedCurve: BasisCurve, Trim1, Trim2, SenseAgreement, MasterRepresentation
    fn process_trimmed_curve_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point2<f64>>> {
        // Get basis curve (attribute 0)
        let basis_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("TrimmedCurve missing BasisCurve".to_string()))?;

        let basis_curve = decoder
            .resolve_ref(basis_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve BasisCurve".to_string()))?;

        // MasterRepresentation (attribute 4) selects which trim flavour wins when
        // both an IfcParameterValue and an IfcCartesianPoint are supplied for the
        // same Trim*. `.CARTESIAN.` means resolve the bounds from the points;
        // anything else (`.PARAMETER.`, `.UNSPECIFIED.`, or missing) keeps the
        // parameter-first behaviour. Either way `extract_trim_select` falls back
        // to whichever flavour is actually present.
        let prefer_cartesian = curve
            .get(4)
            .and_then(|v| v.as_enum())
            .map(|m| m == "CARTESIAN")
            .unwrap_or(false);

        // Get trim parameters
        let trim1 = curve
            .get(1)
            .and_then(|v| self.extract_trim_select(v, prefer_cartesian, decoder));
        let trim2 = curve
            .get(2)
            .and_then(|v| self.extract_trim_select(v, prefer_cartesian, decoder));

        // Get sense agreement (attribute 3) - default true
        let sense = curve
            .get(3)
            .and_then(|v| match v {
                ifc_lite_core::AttributeValue::Enum(s) => Some(s == "T"),
                _ => None,
            })
            .unwrap_or(true);

        // Process basis curve based on type
        match basis_curve.ifc_type {
            IfcType::IfcCircle | IfcType::IfcEllipse => {
                self.process_trimmed_conic(&basis_curve, trim1, trim2, sense, decoder)
            }
            _ => {
                // Fallback: try to process as a regular curve (with depth tracking)
                self.process_curve_with_depth(&basis_curve, decoder, depth + 1)
            }
        }
    }

    /// Extract a single bound of an `IfcTrimmingSelect` list.
    ///
    /// Per the schema each `Trim1`/`Trim2` is a SET of 1..2 of
    /// `IfcParameterValue` and/or `IfcCartesianPoint`. We gather both flavours
    /// when present and let `prefer_cartesian` (derived from the curve's
    /// MasterRepresentation) pick the winner, falling back to whichever one is
    /// actually authored. Cartesian bounds are returned as raw points; the
    /// caller converts them to an angle once it knows the conic's centre,
    /// rotation, and radii — a point bound cannot be turned into a parameter
    /// without that placement.
    fn extract_trim_select(
        &self,
        attr: &ifc_lite_core::AttributeValue,
        prefer_cartesian: bool,
        decoder: &mut EntityDecoder,
    ) -> Option<TrimSelect> {
        let list = attr.as_list()?;
        let mut param: Option<f64> = None;
        let mut point: Option<Point2<f64>> = None;

        for item in list {
            // IFCPARAMETERVALUE(value) is stored as List(["IFCPARAMETERVALUE", value]).
            if let Some(inner_list) = item.as_list() {
                if let Some(type_name) = inner_list.first().and_then(|v| v.as_string()) {
                    if type_name == "IFCPARAMETERVALUE" {
                        param = inner_list.get(1).and_then(|v| v.as_float());
                        continue;
                    }
                }
            }
            // A reference to an IfcCartesianPoint.
            if item.as_entity_ref().is_some() {
                if let Ok(Some(pt)) = decoder.resolve_ref(item) {
                    if pt.ifc_type == IfcType::IfcCartesianPoint {
                        if let Some(coords) = pt.get(0).and_then(|v| v.as_list()) {
                            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                            point = Some(Point2::new(x, y));
                        }
                    }
                }
                continue;
            }
            // Bare numeric fallback: a parameter authored without the
            // IFCPARAMETERVALUE wrapper.
            if let Some(f) = item.as_float() {
                param = Some(f);
            }
        }

        match (prefer_cartesian, point, param) {
            (true, Some(p), _) => Some(TrimSelect::Cartesian(p)),
            (_, _, Some(f)) => Some(TrimSelect::Parameter(f)),
            (_, Some(p), None) => Some(TrimSelect::Cartesian(p)),
            _ => None,
        }
    }

    /// Process trimmed conic (circle or ellipse arc)
    fn process_trimmed_conic(
        &self,
        basis: &DecodedEntity,
        trim1: Option<TrimSelect>,
        trim2: Option<TrimSelect>,
        sense: bool,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let radius = basis.get_float(1).unwrap_or(1.0);
        let radius2 = if basis.ifc_type == IfcType::IfcEllipse {
            basis.get_float(2).unwrap_or(radius)
        } else {
            radius
        };

        let (center, rotation) = self.get_placement_2d(basis, decoder)?;

        // Convert each trim bound to an angle in the conic's local frame.
        // IfcParameterValue bounds are angles in the project's PLANEANGLEUNIT
        // (defaulting to `.to_radians()` collapsed 240° arcs to ~4° on
        // RADIAN-declared files — issue #820, Renga export). IfcCartesianPoint
        // bounds (MasterRepresentation `.CARTESIAN.`, issue #953) are inverted
        // through the placement: un-rotate about the centre, then read the
        // parametric angle off the radii. Without this the cartesian-trimmed
        // semicircle wall profiles in Roof-01_BCAD lost their arc entirely.
        let angle_scale = decoder.plane_angle_to_radians();
        let to_angle = |trim: &TrimSelect| -> f64 {
            match trim {
                TrimSelect::Parameter(v) => v * angle_scale,
                TrimSelect::Cartesian(p) => {
                    let dx = p.x - center.x;
                    let dy = p.y - center.y;
                    let lx = dx * rotation.cos() + dy * rotation.sin();
                    let ly = -dx * rotation.sin() + dy * rotation.cos();
                    // Normalise by the radii so ellipse bounds map to the
                    // parametric angle (for a circle radius == radius2, so this
                    // is plain atan2(ly, lx)).
                    (ly / radius2).atan2(lx / radius)
                }
            }
        };
        let start_angle = trim1.as_ref().map(&to_angle).unwrap_or(0.0);
        let mut end_angle = trim2
            .as_ref()
            .map(&to_angle)
            .unwrap_or(2.0 * std::f64::consts::PI);

        // Handle angle wrapping for arcs that cross the 0°/360° boundary.
        // Example: start=359.98°, end=0° with sense=T should be a tiny arc (~0.02°),
        // not a near-full circle (~359.98°).
        if sense && end_angle < start_angle {
            end_angle += 2.0 * std::f64::consts::PI;
        } else if !sense && end_angle > start_angle {
            end_angle -= 2.0 * std::f64::consts::PI;
        }

        // Adaptive segment count.
        //
        // Angular floor: ~8 segments per 90° (quarter circle), minimum 2 —
        // preserves the previous density for small arcs so nothing regresses.
        //
        // Chord-deviation budget: the angular floor is radius-INDEPENDENT, so a
        // large-radius arc collapses to a coarse polyline (a 12.5 m-radius, 17°
        // arc got only 2 segments → 35 mm chord deviation on a 500 mm wall,
        // ISSUE_129). Cap the sagitta to an absolute ~0.5 mm by adding segments
        // for large physical radii. The budget is expressed in metres and
        // converted through the file's length-unit scale, so it is the same
        // 0.5 mm whether the model is authored in mm or m. The sagitta/radius
        // ratio is `1 - cos(step/2)`; solve for the max step that keeps it
        // within budget. Bounded so a mis-resolved unit can't explode the count.
        let arc_angle = (end_angle - start_angle).abs();
        let by_angle = (arc_angle / std::f64::consts::FRAC_PI_2 * 8.0).ceil() as usize;
        let by_chord = {
            const CHORD_TOL_M: f64 = 5.0e-4; // 0.5 mm absolute deviation budget
            let r_eff = radius.abs().max(radius2.abs());
            let radius_m = r_eff * decoder.length_unit_scale();
            if radius_m > CHORD_TOL_M {
                let rel = (CHORD_TOL_M / radius_m).clamp(1e-9, 0.5);
                let max_step = 2.0 * (1.0 - rel).acos();
                if max_step > 1e-9 {
                    (arc_angle / max_step).ceil() as usize
                } else {
                    0
                }
            } else {
                0
            }
        };
        // Profile arc: historical chord-adaptive density at Medium+ (never finer
        // — denser caps only add earcut bridge slivers), coarser below Medium so
        // large channel/angle fillets don't dominate on preview levels.
        let num_segments = self
            .quality()
            .profile_arc_segments(by_angle.max(by_chord), 2)
            .min(128);
        let mut points = Vec::with_capacity(num_segments + 1);

        let angle_range = if sense {
            end_angle - start_angle
        } else {
            start_angle - end_angle
        };

        for i in 0..=num_segments {
            let t = i as f64 / num_segments as f64;
            let angle = if sense {
                start_angle + t * angle_range
            } else {
                start_angle - t * angle_range.abs()
            };

            let x = radius * angle.cos();
            let y = radius2 * angle.sin();

            let rx = x * rotation.cos() - y * rotation.sin() + center.x;
            let ry = x * rotation.sin() + y * rotation.cos() + center.y;

            points.push(Point2::new(rx, ry));
        }

        Ok(points)
    }

    /// Get 2D placement from entity
    fn get_placement_2d(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Point2<f64>, f64)> {
        let placement_attr = match entity.get(0) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok((Point2::new(0.0, 0.0), 0.0)),
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok((Point2::new(0.0, 0.0), 0.0)),
        };

        let location_attr = placement.get(0);
        let center = if let Some(loc_attr) = location_attr {
            if let Some(loc) = decoder.resolve_ref(loc_attr)? {
                let coords = loc.get(0).and_then(|v| v.as_list());
                if let Some(coords) = coords {
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    Point2::new(x, y)
                } else {
                    Point2::new(0.0, 0.0)
                }
            } else {
                Point2::new(0.0, 0.0)
            }
        } else {
            Point2::new(0.0, 0.0)
        };

        // RefDirection lives at attribute index 1 on IfcAxis2Placement2D, but at
        // index 2 on IfcAxis2Placement3D (index 1 is the Z-Axis there). Reading
        // attribute 1 unconditionally produced a rotation of 0° for any conic
        // anchored to a 3D placement — fine for Z-up profiles but visibly wrong
        // when the X axis is rotated in-plane. Trimmed circles authored with
        // `IfcAxis2Placement3D` (e.g. Revit reinforcement bars in Rebar2.ifc,
        // issue #631) all came out with their arc centres rotated by their
        // RefDirection angle, distorting the directrix.
        let ref_dir_attr_index = if placement.ifc_type == IfcType::IfcAxis2Placement3D {
            2
        } else {
            1
        };
        let rotation = if let Some(dir_attr) = placement.get(ref_dir_attr_index) {
            if let Some(dir) = decoder.resolve_ref(dir_attr)? {
                let ratios = dir.get(0).and_then(|v| v.as_list());
                if let Some(ratios) = ratios {
                    let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0);
                    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    y.atan2(x)
                } else {
                    0.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };

        Ok((center, rotation))
    }

    /// Process circle curve (full circle)
    fn process_circle_curve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let radius = curve.get_float(1).unwrap_or(1.0);
        let (center, rotation) = self.get_placement_2d(curve, decoder)?;

        let segments = self.quality().circle_profile_segments(36);
        let mut points = Vec::with_capacity(segments);

        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            let x = radius * angle.cos();
            let y = radius * angle.sin();

            let rx = x * rotation.cos() - y * rotation.sin() + center.x;
            let ry = x * rotation.sin() + y * rotation.cos() + center.y;

            points.push(Point2::new(rx, ry));
        }

        Ok(points)
    }

    /// Process ellipse curve (full ellipse)
    fn process_ellipse_curve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let semi_axis1 = curve.get_float(1).unwrap_or(1.0);
        let semi_axis2 = curve.get_float(2).unwrap_or(1.0);
        let (center, rotation) = self.get_placement_2d(curve, decoder)?;

        let segments = self.quality().circle_profile_segments(36);
        let mut points = Vec::with_capacity(segments);

        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            let x = semi_axis1 * angle.cos();
            let y = semi_axis2 * angle.sin();

            let rx = x * rotation.cos() - y * rotation.sin() + center.x;
            let ry = x * rotation.sin() + y * rotation.cos() + center.y;

            points.push(Point2::new(rx, ry));
        }

        Ok(points)
    }

    /// Process polyline into 2D points
    /// IfcPolyline: Points (list of IfcCartesianPoint)
    #[inline]
    fn process_polyline(
        &self,
        polyline: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        // Get points list (attribute 0)
        let points_attr = polyline
            .get(0)
            .ok_or_else(|| Error::geometry("Polyline missing Points".to_string()))?;

        let point_entities = decoder.resolve_ref_list(points_attr)?;

        let mut points = Vec::with_capacity(point_entities.len());
        for point_entity in point_entities {
            if point_entity.ifc_type != IfcType::IfcCartesianPoint {
                continue;
            }

            // Get coordinates (attribute 0)
            let coords_attr = point_entity
                .get(0)
                .ok_or_else(|| Error::geometry("CartesianPoint missing coordinates".to_string()))?;

            let coords = coords_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);

            points.push(Point2::new(x, y));
        }

        Ok(points)
    }

    /// Process indexed polycurve into 2D points
    /// IfcIndexedPolyCurve: Points (IfcCartesianPointList2D), Segments (optional), SelfIntersect
    fn process_indexed_polycurve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        // Get points list (attribute 0) - references IfcCartesianPointList2D
        let points_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("IndexedPolyCurve missing Points".to_string()))?;

        let points_list = decoder
            .resolve_ref(points_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Points list".to_string()))?;

        // IfcCartesianPointList2D: CoordList (list of 2D coordinates)
        let coord_list_attr = points_list
            .get(0)
            .ok_or_else(|| Error::geometry("CartesianPointList2D missing CoordList".to_string()))?;

        let coord_list = coord_list_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

        // Parse all 2D points from the coordinate list
        let all_points: Vec<Point2<f64>> = coord_list
            .iter()
            .filter_map(|coord| {
                coord.as_list().and_then(|coords| {
                    let x = coords.first()?.as_float()?;
                    let y = coords.get(1)?.as_float()?;
                    Some(Point2::new(x, y))
                })
            })
            .collect();

        // Get segments (attribute 1) - optional, if not present use all points in order
        let segments_attr = curve.get(1);

        if segments_attr.is_none() || segments_attr.map(|a| a.is_null()).unwrap_or(true) {
            // No segments specified - use all points in order
            return Ok(all_points);
        }

        // Process segments (IfcLineIndex or IfcArcIndex)
        let segments = segments_attr
            .unwrap()
            .as_list()
            .ok_or_else(|| Error::geometry("Expected segments list".to_string()))?;

        let mut result_points = Vec::new();

        for segment in segments {
            // Each segment is either IFCLINEINDEX((i1,i2,...)) or IFCARCINDEX((i1,i2,i3))
            // Typed values are stored as List([String("IFCLINEINDEX"), List([indices...])])
            // So we need to extract the inner list AND check the type name
            let (is_arc, indices) = if let Some(segment_list) = segment.as_list() {
                // Check if this is a typed value: List([String(type_name), List([indices...])])
                // Typed values like IFCLINEINDEX((1,2)) are stored as:
                // List([String("IFCLINEINDEX"), List([Integer(1), Integer(2)])])
                if segment_list.len() >= 2 {
                    // First element is type name (String), second is the actual indices list
                    let type_name = segment_list
                        .first()
                        .and_then(|v| v.as_string())
                        .unwrap_or("");
                    let is_arc_type = type_name.to_uppercase().contains("ARC");
                    if let Some(AttributeValue::List(indices_list)) = segment_list.get(1) {
                        (is_arc_type, Some(indices_list.as_slice()))
                    } else {
                        // Fallback: maybe it's a direct list of indices (not typed)
                        (false, Some(segment_list))
                    }
                } else {
                    // Single element or empty - treat as direct list (line)
                    (false, Some(segment_list))
                }
            } else {
                (false, None)
            };

            if let Some(indices) = indices {
                let idx_values: Vec<usize> = indices
                    .iter()
                    .filter_map(|v| v.as_float())
                    // 1-indexed to 0-indexed; reject non-finite, <1, or fractional
                    // values (e.g. 1.9) instead of truncating them to a wrong vertex.
                    .filter_map(|f| {
                        if !f.is_finite() || f < 1.0 || f.fract() != 0.0 {
                            return None;
                        }
                        (f as usize).checked_sub(1)
                    })
                    .collect();

                if is_arc && idx_values.len() == 3 {
                    // Arc segment - 3 points define an arc (ONLY if type is IFCARCINDEX)
                    let p1 = all_points.get(idx_values[0]).copied();
                    let p2 = all_points.get(idx_values[1]).copied(); // Mid-point
                    let p3 = all_points.get(idx_values[2]).copied();

                    if let (Some(start), Some(mid), Some(end)) = (p1, p2, p3) {
                        // Approximate arc with adaptive segment count based on arc size
                        // Calculate approximate arc angle from chord length vs radius
                        let chord_len =
                            ((end.x - start.x).powi(2) + (end.y - start.y).powi(2)).sqrt();
                        let mid_chord = ((mid.x - (start.x + end.x) / 2.0).powi(2)
                            + (mid.y - (start.y + end.y) / 2.0).powi(2))
                        .sqrt();
                        // Estimate arc angle: larger mid deviation = larger arc
                        let arc_estimate = if chord_len > 1e-10 {
                            (mid_chord / chord_len).abs().min(1.0).acos() * 2.0
                        } else {
                            0.5
                        };
                        // 2D profile arc → extruded cap. Medium+ keeps historical
                        // density; below Medium it coarsens.
                        let arc_base =
                            (arc_estimate / std::f64::consts::FRAC_PI_2 * 8.0).ceil() as usize;
                        let num_segments =
                            self.quality().profile_arc_segments(arc_base, 4).min(16);
                        let arc_points = self.approximate_arc_3pt(start, mid, end, num_segments);
                        for pt in arc_points {
                            if result_points.last() != Some(&pt) {
                                result_points.push(pt);
                            }
                        }
                    }
                } else {
                    // Line segment - add all points (includes IFCLINEINDEX with any number of points)
                    for &idx in &idx_values {
                        if let Some(&pt) = all_points.get(idx) {
                            if result_points.last() != Some(&pt) {
                                result_points.push(pt);
                            }
                        }
                    }
                }
            }
            // else: segment is not a list, skip it
        }

        Ok(result_points)
    }

    /// Approximate a 3-point arc with line segments
    fn approximate_arc_3pt(
        &self,
        p1: Point2<f64>,
        p2: Point2<f64>,
        p3: Point2<f64>,
        num_segments: usize,
    ) -> Vec<Point2<f64>> {
        // Find circle center from 3 points
        let ax = p1.x;
        let ay = p1.y;
        let bx = p2.x;
        let by = p2.y;
        let cx = p3.x;
        let cy = p3.y;

        let d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));

        // Check for collinearity using a RELATIVE tolerance based on the arc span
        // The determinant d scales with the square of the point distances
        let arc_span = ((p3.x - p1.x).powi(2) + (p3.y - p1.y).powi(2)).sqrt();
        let collinear_tolerance = 1e-6 * arc_span.powi(2).max(1e-10);
        if d.abs() < collinear_tolerance {
            // Points are collinear - return as line
            return vec![p1, p2, p3];
        }

        // Calculate center
        let ux_num = (ax * ax + ay * ay) * (by - cy)
            + (bx * bx + by * by) * (cy - ay)
            + (cx * cx + cy * cy) * (ay - by);
        let uy_num = (ax * ax + ay * ay) * (cx - bx)
            + (bx * bx + by * by) * (ax - cx)
            + (cx * cx + cy * cy) * (bx - ax);
        let ux = ux_num / d;
        let uy = uy_num / d;
        let center = Point2::new(ux, uy);
        let radius = ((p1.x - center.x).powi(2) + (p1.y - center.y).powi(2)).sqrt();
        // If radius is more than 100x the arc span, the points are essentially collinear
        if radius > arc_span * 100.0 {
            return vec![p1, p2, p3];
        }

        // Calculate angles
        let angle1 = (p1.y - center.y).atan2(p1.x - center.x);
        let angle3 = (p3.y - center.y).atan2(p3.x - center.x);
        let angle2 = (p2.y - center.y).atan2(p2.x - center.x);

        // Normalize angle difference to [-PI, PI]
        fn normalize_angle(a: f64) -> f64 {
            let mut a = a % (2.0 * PI);
            if a > PI {
                a -= 2.0 * PI;
            } else if a < -PI {
                a += 2.0 * PI;
            }
            a
        }

        // Determine if we should go clockwise or counterclockwise from angle1 to angle3
        // The correct direction is the one that passes through angle2
        let diff_direct = normalize_angle(angle3 - angle1);
        let diff_to_mid = normalize_angle(angle2 - angle1);
        let go_direct = if diff_direct > 0.0 {
            // Direct path is counterclockwise (positive angles)
            diff_to_mid > 0.0 && diff_to_mid < diff_direct
        } else {
            // Direct path is clockwise (negative angles)
            diff_to_mid < 0.0 && diff_to_mid > diff_direct
        };

        let start_angle = angle1;
        let end_angle = if go_direct {
            angle1 + diff_direct
        } else {
            // Go the other way around
            if diff_direct > 0.0 {
                angle1 + diff_direct - 2.0 * PI
            } else {
                angle1 + diff_direct + 2.0 * PI
            }
        };

        // Generate arc points
        let mut points = Vec::with_capacity(num_segments + 1);
        for i in 0..=num_segments {
            let t = i as f64 / num_segments as f64;
            let angle = start_angle + t * (end_angle - start_angle);
            points.push(Point2::new(
                center.x + radius * angle.cos(),
                center.y + radius * angle.sin(),
            ));
        }

        points
    }

    /// Process indexed polycurve in 3D space.
    ///
    /// IfcIndexedPolyCurve(Points, Segments, SelfIntersect) where Points is an
    /// IfcCartesianPointList (2D or 3D). The 2D-only sibling at
    /// `process_indexed_polycurve` is used for profile-defining curves; this
    /// version is used as a directrix for IfcSweptDiskSolid and similar 3D
    /// sweeps (issue #631 — IfcReinforcingBar stirrups).
    ///
    /// `IfcCartesianPointList2D` inputs are treated as planar at z=0 so the
    /// behavior matches the 2D path on existing fixtures.
    fn process_indexed_polycurve_3d(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        let points_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("IndexedPolyCurve missing Points".to_string()))?;

        let points_list = decoder
            .resolve_ref(points_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Points list".to_string()))?;

        let coord_list = points_list
            .get(0)
            .and_then(|a| a.as_list())
            .ok_or_else(|| Error::geometry("CartesianPointList missing CoordList".to_string()))?;

        // IfcCartesianPointList3D has 3-tuples; IfcCartesianPointList2D has
        // 2-tuples. Read whatever is there and default missing components to 0.
        let all_points: Vec<Point3<f64>> = coord_list
            .iter()
            .filter_map(|coord| {
                coord.as_list().map(|coords| {
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                    Point3::new(x, y, z)
                })
            })
            .collect();

        let segments_attr = curve.get(1);
        if segments_attr.is_none() || segments_attr.map(|a| a.is_null()).unwrap_or(true) {
            return Ok(all_points);
        }

        let segments = segments_attr
            .unwrap()
            .as_list()
            .ok_or_else(|| Error::geometry("Expected segments list".to_string()))?;

        let mut result: Vec<Point3<f64>> = Vec::new();
        for segment in segments {
            // Each segment is IFCLINEINDEX((i1,i2,...)) or IFCARCINDEX((i1,i2,i3)).
            // Typed values arrive as List([String("IFCLINEINDEX"), List([indices...])]).
            let (is_arc, indices) = if let Some(segment_list) = segment.as_list() {
                if segment_list.len() >= 2 {
                    let type_name = segment_list
                        .first()
                        .and_then(|v| v.as_string())
                        .unwrap_or("");
                    let is_arc_type = type_name.to_uppercase().contains("ARC");
                    if let Some(AttributeValue::List(indices_list)) = segment_list.get(1) {
                        (is_arc_type, Some(indices_list.as_slice()))
                    } else {
                        (false, Some(segment_list))
                    }
                } else {
                    (false, Some(segment_list))
                }
            } else {
                (false, None)
            };

            let Some(indices) = indices else { continue };
            let idx_values: Vec<usize> = indices
                .iter()
                .filter_map(|v| v.as_float())
                // 1-indexed to 0-indexed; reject non-finite, <1, or fractional
                // values (e.g. 1.9) instead of truncating them to a wrong vertex.
                .filter_map(|f| {
                    if !f.is_finite() || f < 1.0 || f.fract() != 0.0 {
                        return None;
                    }
                    (f as usize).checked_sub(1)
                })
                .collect();

            if is_arc && idx_values.len() == 3 {
                let p1 = all_points.get(idx_values[0]).copied();
                let p2 = all_points.get(idx_values[1]).copied();
                let p3 = all_points.get(idx_values[2]).copied();
                if let (Some(start), Some(mid), Some(end)) = (p1, p2, p3) {
                    // Adaptive segment count: estimate sweep from chord vs.
                    // mid-deviation, same heuristic as the 2D path.
                    let chord = end - start;
                    let chord_len = chord.norm();
                    let mid_offset = mid - Point3::new(
                        0.5 * (start.x + end.x),
                        0.5 * (start.y + end.y),
                        0.5 * (start.z + end.z),
                    );
                    let mid_dev = mid_offset.norm();
                    let arc_estimate = if chord_len > 1e-10 {
                        (mid_dev / chord_len).abs().min(1.0).acos() * 2.0
                    } else {
                        0.5
                    };
                    let arc_base =
                        (arc_estimate / std::f64::consts::FRAC_PI_2 * 8.0).ceil() as usize;
                    let num_segments = scale_segments(arc_base, 4, 16, self.quality());
                    let arc_points = approximate_arc_3pt_3d(start, mid, end, num_segments);
                    for pt in arc_points {
                        if !same_point_3d(result.last(), &pt) {
                            result.push(pt);
                        }
                    }
                }
            } else {
                // Line segment — IfcLineIndex permits any number of indices
                for &idx in &idx_values {
                    if let Some(&pt) = all_points.get(idx) {
                        if !same_point_3d(result.last(), &pt) {
                            result.push(pt);
                        }
                    }
                }
            }
        }

        Ok(result)
    }

    /// Process composite curve into 2D points
    /// IfcCompositeCurve: Segments (list of IfcCompositeCurveSegment), SelfIntersect
    fn process_composite_curve_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point2<f64>>> {
        // Get segments list (attribute 0)
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;

        let segments = decoder.resolve_ref_list(segments_attr)?;

        let mut all_points = Vec::new();

        for segment in segments {
            // IfcCompositeCurveSegment: Transition, SameSense, ParentCurve
            if segment.ifc_type != IfcType::IfcCompositeCurveSegment {
                continue;
            }

            // Get ParentCurve (attribute 2)
            let parent_curve_attr = segment.get(2).ok_or_else(|| {
                Error::geometry("CompositeCurveSegment missing ParentCurve".to_string())
            })?;

            let parent_curve = decoder
                .resolve_ref(parent_curve_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve ParentCurve".to_string()))?;

            // Get SameSense (attribute 1) - whether to reverse the curve
            // Note: IFC enum values like ".T." are parsed/stored as "T" without dots
            let same_sense = segment
                .get(1)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(s) => Some(s == "T" || s == "TRUE"),
                    _ => None,
                })
                .unwrap_or(true);

            // Process the parent curve (with depth tracking)
            let mut segment_points =
                self.process_curve_with_depth(&parent_curve, decoder, depth + 1)?;

            if !same_sense {
                segment_points.reverse();
            }

            // Append to result, avoiding duplicates at connection points
            for pt in segment_points {
                if all_points.last() != Some(&pt) {
                    all_points.push(pt);
                }
            }
        }

        Ok(all_points)
    }

    /// Process composite profile (combination of profiles)
    /// IfcCompositeProfileDef: ProfileType, ProfileName, Profiles, Label
    fn process_composite_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Profile2D> {
        // Get profiles list (attribute 2)
        let profiles_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Composite profile missing Profiles".to_string()))?;

        let sub_profiles = decoder.resolve_ref_list(profiles_attr)?;

        if sub_profiles.is_empty() {
            return Err(Error::geometry(
                "Composite profile has no sub-profiles".to_string(),
            ));
        }

        // Process first profile as base
        let mut result = self.process_with_depth(&sub_profiles[0], decoder, depth + 1)?;

        // Add remaining profiles as holes (simplified - assumes they're holes)
        for sub_profile in &sub_profiles[1..] {
            let hole = self.process_with_depth(sub_profile, decoder, depth + 1)?;
            result.add_hole(hole.outer);
        }

        Ok(result)
    }
}

/// Resolve an `IfcAxis2Placement2D` or `IfcAxis2Placement3D` into its
/// origin point AND local X-axis (RefDirection) as a unit vector. Used to
/// extrapolate the last `IfcCurveSegment`'s terminal point:
/// `origin + x_axis * SegmentLength` is exact for straight segments and a
/// tangent approximation for arcs / clothoids — both strictly better than
/// dropping the terminal sample entirely, which caused
/// `sample_polyline_at_distance` to clamp any product whose
/// `DistanceAlong` fell inside the final segment to its start station.
///
/// IFC4x3 attribute layout:
///   IfcAxis2Placement2D: 0 Location, 1 RefDirection
///   IfcAxis2Placement3D: 0 Location, 1 Axis (local Z), 2 RefDirection (local X)
///
/// Returns `(origin, x_axis)` with `x_axis` defaulting to +X when the
/// RefDirection is absent or zero-length (matches the EXPRESS default).
fn axis2_placement_location_and_x_axis_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<(Point3<f64>, nalgebra::Vector3<f64>)> {
    let is_3d = placement.ifc_type == IfcType::IfcAxis2Placement3D;
    let is_2d = placement.ifc_type == IfcType::IfcAxis2Placement2D;
    if !is_2d && !is_3d {
        return None;
    }
    let location_attr = placement.get(0)?;
    if location_attr.is_null() {
        return None;
    }
    let location = decoder.resolve_ref(location_attr).ok().flatten()?;
    if location.ifc_type != IfcType::IfcCartesianPoint {
        return None;
    }
    let coords = location.get(0)?.as_list()?;
    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
    let origin = Point3::new(x, y, z);

    // RefDirection slot: index 2 on 3D, index 1 on 2D.
    let ref_dir_idx = if is_3d { 2 } else { 1 };
    let mut x_axis = nalgebra::Vector3::x();
    if let Some(dir_attr) = placement.get(ref_dir_idx) {
        if !dir_attr.is_null() {
            if let Some(dir) = decoder.resolve_ref(dir_attr).ok().flatten() {
                if dir.ifc_type == IfcType::IfcDirection {
                    if let Some(ratios) = dir.get(0).and_then(|a| a.as_list()) {
                        let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                        let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let dz = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let v = nalgebra::Vector3::new(dx, dy, dz);
                        if v.norm() > 1e-12 {
                            x_axis = v.normalize();
                        }
                    }
                }
            }
        }
    }
    Some((origin, x_axis))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_loop_self_intersects_detects_bowtie() {
        // Simple unit square — no crossings.
        let square = [
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ];
        assert!(!closed_loop_self_intersects(&square));

        // Bow-tie: swapping the last two vertices makes the closing edges
        // cross in the middle.
        let bowtie = [
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(0.0, 1.0),
            Point2::new(1.0, 1.0),
        ];
        assert!(closed_loop_self_intersects(&bowtie));

        // Degenerate (fewer than 4 vertices) can't self-cross.
        assert!(!closed_loop_self_intersects(&square[..3]));
    }

    /// Build a dense closed loop for a thin annular sector centred at
    /// (0, -radius) (the issue #820 topology): an outer arc at `radius` and an
    /// inner arc at `radius - thickness`, swept `span` radians and joined by
    /// short radial caps. `seg` samples per arc.
    fn annular_sector_loop(radius: f64, thickness: f64, span: f64, seg: usize) -> Vec<Point2<f64>> {
        let c = Point2::new(0.0, -radius);
        let mut loop_ = Vec::with_capacity(2 * seg + 2);
        for i in 0..=seg {
            let a = -span / 2.0 + span * (i as f64 / seg as f64);
            loop_.push(Point2::new(c.x + radius * a.cos(), c.y + radius * a.sin()));
        }
        let inner = radius - thickness;
        for i in 0..=seg {
            let a = span / 2.0 - span * (i as f64 / seg as f64);
            loop_.push(Point2::new(c.x + inner * a.cos(), c.y + inner * a.sin()));
        }
        loop_
    }

    fn loop_area(loop_: &[Point2<f64>]) -> f64 {
        let n = loop_.len();
        let mut a = 0.0;
        for i in 0..n {
            let p = loop_[i];
            let q = loop_[(i + 1) % n];
            a += p.x * q.y - q.x * p.y;
        }
        (a * 0.5).abs()
    }

    #[test]
    fn simplify_thin_annular_sector_stays_simple_and_area_preserving() {
        // Regression for issue #820 *and* the silent-area-distortion class the
        // review flagged. A thin curved wall has a feature size (its thickness)
        // far below the bbox diagonal; the thickness-capped RDP epsilon must
        // keep every simplification both topologically simple (no folded-flap
        // seam) and area-faithful. The first row is the real fixture's
        // proportions (r=12000, 100 mm, 240°); the rest are the thicker/shorter
        // sectors the reviewer reproduced losing/gaining 5–13% area under the
        // un-capped epsilon.
        let cases = [
            (12000.0, 100.0, 240.0_f64),
            (12000.0, 300.0, 240.0),
            (12000.0, 600.0, 90.0),
            (12000.0, 600.0, 180.0),
        ];
        for (radius, thickness, span_deg) in cases {
            let span = span_deg.to_radians();
            let dense = annular_sector_loop(radius, thickness, span, 200);
            assert!(
                !closed_loop_self_intersects(&dense),
                "input sector r={radius} t={thickness} {span_deg}° should start simple",
            );
            let out = simplify_smooth_curve_polyline(&dense);

            // Topology: never a folded-flap seam.
            assert!(
                !closed_loop_self_intersects(&out),
                "simplified sector r={radius} t={thickness} {span_deg}° self-intersects",
            );

            // Area: within 2% of the dense original (was up to ±13% pre-fix).
            let (a_in, a_out) = (loop_area(&dense), loop_area(&out));
            let rel = (a_out - a_in).abs() / a_in;
            assert!(
                rel < 0.02,
                "sector r={radius} t={thickness} {span_deg}°: area drift {:.1}% \
                 (in={a_in:.0} out={a_out:.0}) — thin curved wall was distorted",
                rel * 100.0,
            );
        }
    }

    #[test]
    fn simplify_still_reduces_fat_round_disk() {
        // Guards THIN_FEATURE_RATIO from being set so high it suppresses the
        // issue #635 case it must preserve: an over-tessellated round window
        // (a *fat* disk, half-thickness ≈ radius/2) must still simplify to a
        // small recognizable polygon so void cuts fit the CSG polygon budget.
        let mut disk = Vec::new();
        let seg = 127;
        for i in 0..seg {
            let a = std::f64::consts::TAU * (i as f64 / seg as f64);
            disk.push(Point2::new(0.5 * a.cos(), 0.5 * a.sin()));
        }
        let out = simplify_smooth_curve_polyline(&disk);
        assert!(
            out.len() < disk.len() && out.len() >= SIMPLIFIED_MIN_VERTICES,
            "round disk should simplify from {} to [{SIMPLIFIED_MIN_VERTICES}, {}) verts, got {}",
            disk.len(),
            disk.len(),
            out.len(),
        );
        assert!(!closed_loop_self_intersects(&out));
    }

    fn ellipse_loop(ar: f64, seg: usize) -> Vec<Point2<f64>> {
        let (a, b) = (ar * 0.5, 0.5);
        (0..seg)
            .map(|i| {
                let t = std::f64::consts::TAU * (i as f64 / seg as f64);
                Point2::new(a * t.cos(), b * t.sin())
            })
            .collect()
    }

    #[test]
    fn elongated_filled_ellipse_is_not_thin_gated() {
        // Regression for the review's P1. An elongated *filled* ellipse is thin
        // by the half-thickness/diagonal measure (an 8:1 ellipse sits at ~0.048,
        // below THIN_FEATURE_RATIO, rising to ~0.020 at 20:1) — but it is convex
        // and does NOT double back, so the thin gate must not fire on it. The
        // earlier thinness-only gate wrongly skipped these, pinning a densely
        // sampled elliptical opening at its full vertex count, overflowing the
        // BSP void-cut budget and forcing the AABB-rectangle fallback (#635).
        for ar in [6.0_f64, 8.0, 12.0, 20.0] {
            assert!(
                !loop_doubles_back(&ellipse_loop(ar, 128)),
                "AR={ar} filled ellipse is convex — must not read as doubling back",
            );
        }

        // With the gate no longer blocking it, an elongated ellipse simplifies
        // exactly as it does without any thin gate (i.e. as on main): RDP +
        // SIMPLIFIED_MIN_VERTICES. At 8:1, RDP retains ≥ the floor, so it
        // genuinely reduces and stays simple. (Higher ratios bottom out at the
        // floor and keep the original — a pre-existing #635 limitation, not the
        // thin gate, and unchanged by this fix.)
        let ellipse = ellipse_loop(8.0, 128);
        let out = simplify_smooth_curve_polyline(&ellipse);
        assert!(
            out.len() < ellipse.len() && out.len() >= SIMPLIFIED_MIN_VERTICES,
            "8:1 ellipse must still simplify (was wrongly thin-gated): {} -> {} verts",
            ellipse.len(),
            out.len(),
        );
        assert!(!closed_loop_self_intersects(&out));
        // Inscribed simplification of an elongated convex opening shaves a few
        // percent — acceptable for a void approximation (and the same as main).
        let rel = (loop_area(&out) - loop_area(&ellipse)).abs() / loop_area(&ellipse);
        assert!(rel < 0.08, "8:1 ellipse area drift {:.1}%", rel * 100.0);
    }

    #[test]
    fn doubles_back_ignores_localized_spikes() {
        // The reflex-fraction metric must flag a genuine two-arc annular sector
        // but NOT a convex thin opening carrying a single localized defect — a
        // lone inward notch or the sub-mm out-and-back jog where a composite
        // curve closes. A total-turning measure double-counts such a spike and
        // would wrongly gate these convex openings back into the #635 AABB cut.

        // Genuine doubling-back: the #820 thin annular sector.
        assert!(loop_doubles_back(&annular_sector_loop(
            12000.0,
            100.0,
            (240.0_f64).to_radians(),
            128
        )));

        // Clean convex ellipse — not doubling back.
        let mut e = ellipse_loop(8.0, 128);
        assert!(!loop_doubles_back(&e));

        // ...with one deep inward notch at the blunt (x-tip) vertex. Find the
        // vertex of greatest |x| and pull it 25% of the minor axis toward centre.
        let tip = (0..e.len())
            .max_by(|&i, &j| e[i].x.abs().partial_cmp(&e[j].x.abs()).unwrap())
            .unwrap();
        e[tip].x *= 0.75;
        assert!(
            !loop_doubles_back(&e),
            "a single notch on a convex ellipse must not read as doubling back",
        );

        // Convex disk with a tiny out-and-back seam jog (a real, non-degenerate
        // near-coincident self-intersection of the kind the #820 seam leaves).
        let mut disk: Vec<Point2<f64>> = (0..128)
            .map(|i| {
                let t = std::f64::consts::TAU * (i as f64 / 128.0);
                Point2::new(t.cos(), t.sin())
            })
            .collect();
        // Insert a 1e-4 radial jog at vertex 0's neighbourhood.
        disk.insert(1, Point2::new(disk[0].x * 0.9999, disk[0].y * 0.9999));
        assert!(
            !loop_doubles_back(&disk),
            "a sub-mm seam jog on a convex loop must not read as doubling back",
        );
    }

    #[test]
    fn doubles_back_independent_of_per_boundary_sampling_density() {
        // Codex review: measuring reflex VERTICES (not arc length) let a thin
        // sector slip when its two arcs are sampled at very different densities.
        // Their exact example: a 90° sector, r=12000, thickness=10, with the
        // convex outer arc finely sampled (96 segs) and the reflex inner arc
        // coarsely (16 segs). A count fraction reads ~0.13 (< gate) and the
        // wall is wrongly simplified to ~55% area drift; an arc-length fraction
        // reads ~0.5 because the inner and outer arcs are nearly equal LENGTH.
        let centre = Point2::new(0.0, -12000.0);
        let (r_out, r_in) = (12000.0, 12000.0 - 10.0);
        let span = (90.0_f64).to_radians();
        let mut loop_ = Vec::new();
        for i in 0..=96 {
            let a = -span / 2.0 + span * (i as f64 / 96.0);
            loop_.push(Point2::new(centre.x + r_out * a.cos(), centre.y + r_out * a.sin()));
        }
        for i in 0..=16 {
            let a = span / 2.0 - span * (i as f64 / 16.0);
            loop_.push(Point2::new(centre.x + r_in * a.cos(), centre.y + r_in * a.sin()));
        }
        assert!(
            loop_doubles_back(&loop_),
            "a non-uniformly tessellated thin sector must still read as doubling back",
        );
        // And it is gated end-to-end: simplify returns the faithful original.
        let out = simplify_smooth_curve_polyline(&loop_);
        assert_eq!(out.len(), loop_.len(), "skewed-sampling thin sector must be gated");
    }

    #[test]
    fn test_rectangle_profile() {
        let content = r#"
#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,100.0,200.0);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(1).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 4);
        assert!(!profile.outer.is_empty());
    }

    #[test]
    fn test_circle_profile() {
        let content = r#"
#1=IFCCIRCLEPROFILEDEF(.AREA.,$,$,50.0);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(1).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 36); // Circle with 36 segments
        assert!(!profile.outer.is_empty());
    }

    #[test]
    fn test_i_shape_profile() {
        let content = r#"
#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,200.0,300.0,10.0,15.0,$,$,$,$);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(1).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 12); // I-shape has 12 vertices
        assert!(!profile.outer.is_empty());
    }

    /// Shoelace area of a profile's outer boundary.
    fn outer_area(profile: &Profile2D) -> f64 {
        let p = &profile.outer;
        let n = p.len();
        let mut a = 0.0;
        for i in 0..n {
            let b = p[(i + 1) % n];
            a += p[i].x * b.y - b.x * p[i].y;
        }
        a.abs() * 0.5
    }

    // I-shape FilletRadius rounds the four web↔flange junctions (concave, adds
    // root-fillet material). ISSUE_021 I-beam #4416: W180 D171 tw6 tf9.5,
    // FilletRadius 15. Closed-form area: sharp 4332 + 4·r²(1−π/4) ≈ 4525.1 mm².
    #[test]
    fn test_i_shape_honours_fillet_radius() {
        let sharp = process_content(
            "#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,180.,171.,6.,9.5,$,$,$);\n",
            1,
        );
        let filleted = process_content(
            "#1=IFCISHAPEPROFILEDEF(.AREA.,$,$,180.,171.,6.,9.5,15.,$,$);\n",
            1,
        );
        assert_eq!(sharp.outer.len(), 12, "sharp I should stay 12 points");
        assert!(
            filleted.outer.len() > 12,
            "fillets not generated: {} points",
            filleted.outer.len()
        );
        // Closed-form uses ideal arcs; the 6-segment-per-corner tessellation of
        // four concave fillets over-estimates by ~8 mm² (chords bow outward on a
        // concave fillet). Tolerance absorbs that while still pinning the sign
        // (filleted ≈ 4525, clearly above sharp 4332).
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 4332.0 + 4.0 * 15.0 * 15.0 * k;
        let area = outer_area(&filleted);
        assert!(
            (area - expected).abs() < 15.0 && area > outer_area(&sharp) + 100.0,
            "I fillet area {area:.2} vs expected {expected:.2} (sharp {:.2})",
            outer_area(&sharp)
        );
        // bbox unchanged (fillets are interior).
        let (mnx, mny, mxx, mxy) = outer_bbox(&filleted);
        assert!((mxx - mnx - 180.0).abs() < 1e-6 && (mxy - mny - 171.0).abs() < 1e-6);
    }

    // U-shape (channel): FilletRadius rounds the 2 inner web↔flange junctions
    // (concave, +), EdgeRadius rounds the 2 flange toes (convex, −). Depth 200,
    // FlangeWidth 80, WebThickness 10, FlangeThickness 12, FilletRadius 12,
    // EdgeRadius 6. Sharp 3680 + 2·12²(1−π/4) − 2·6²(1−π/4) ≈ 3726.3 mm².
    #[test]
    fn test_u_shape_honours_radii() {
        let sharp = process_content(
            "#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,10.,12.,$,$,$,$);\n",
            1,
        );
        let filleted = process_content(
            "#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,10.,12.,12.,6.,$,$);\n",
            1,
        );
        assert_eq!(sharp.outer.len(), 8);
        assert!(filleted.outer.len() > 8, "U fillets not generated");
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 3680.0 + 2.0 * 144.0 * k - 2.0 * 36.0 * k;
        let area = outer_area(&filleted);
        assert!(
            (area - expected).abs() < 12.0,
            "U area {area:.2} vs expected {expected:.2}"
        );
        // bbox unchanged: FlangeWidth × Depth.
        let (mnx, mny, mxx, mxy) = outer_bbox(&filleted);
        assert!((mxx - mnx - 80.0).abs() < 1e-6 && (mxy - mny - 200.0).abs() < 1e-6);
    }

    // T-shape: FilletRadius at the 2 web↔flange junctions (concave, +),
    // FlangeEdgeRadius at the 2 flange toes and WebEdgeRadius at the 2 web-end
    // corners (convex, −). Depth 100, FlangeWidth 80, WebThickness 10,
    // FlangeThickness 12, FilletRadius 8, FlangeEdgeRadius 4, WebEdgeRadius 3.
    // Sharp 1840 + 2·8²(1−π/4) − 2·4²(1−π/4) − 2·3²(1−π/4) ≈ 1856.8 mm².
    #[test]
    fn test_t_shape_honours_radii() {
        let sharp = process_content(
            "#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,12.,$,$,$,$,$);\n",
            1,
        );
        let filleted = process_content(
            "#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,12.,8.,4.,3.,$,$);\n",
            1,
        );
        assert_eq!(sharp.outer.len(), 8);
        assert!(filleted.outer.len() > 8, "T fillets not generated");
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 1840.0 + 2.0 * 64.0 * k - 2.0 * 16.0 * k - 2.0 * 9.0 * k;
        let area = outer_area(&filleted);
        assert!(
            (area - expected).abs() < 10.0,
            "T area {area:.2} vs expected {expected:.2}"
        );
        // bbox unchanged: FlangeWidth × Depth.
        let (mnx, mny, mxx, mxy) = outer_bbox(&filleted);
        assert!((mxx - mnx - 80.0).abs() < 1e-6 && (mxy - mny - 100.0).abs() < 1e-6);
    }

    /// (min_x, min_y, max_x, max_y) of a profile's outer boundary.
    fn outer_bbox(profile: &Profile2D) -> (f64, f64, f64, f64) {
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for p in &profile.outer {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
        (min_x, min_y, max_x, max_y)
    }

    fn process_content(content: &str, id: u32) -> Profile2D {
        let mut decoder = EntityDecoder::new(content);
        let processor = ProfileProcessor::new(IfcSchema::new());
        let entity = decoder.decode_by_id(id).unwrap();
        processor
            .process(&entity, &mut decoder, TessellationQuality::Medium)
            .unwrap()
    }

    // A U-shape (channel) is centred on its bounding box: X spans
    // -FlangeWidth/2..+FlangeWidth/2, not 0..FlangeWidth. Regression for channels
    // being offset by half the flange width.
    #[test]
    fn test_u_shape_is_centered() {
        // Depth 160, FlangeWidth 64, WebThickness 5, FlangeThickness 8.4
        let profile =
            process_content("#1=IFCUSHAPEPROFILEDEF(.AREA.,$,$,160.,64.,5.,8.4,$,$,$,$);\n", 1);
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!((max_x - min_x - 64.0).abs() < 1e-9, "width should be FlangeWidth");
        assert!((max_y - min_y - 160.0).abs() < 1e-9, "height should be Depth");
    }

    // An L-shape (angle) is centred on its bounding box rather than having its
    // corner at the origin.
    #[test]
    fn test_l_shape_is_centered() {
        // Depth 100, Width 80, Thickness 10
        let profile =
            process_content("#1=IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,$,$,$,$,$);\n", 1);
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!((max_x - min_x - 80.0).abs() < 1e-9, "width should be Width");
        assert!((max_y - min_y - 100.0).abs() < 1e-9, "height should be Depth");
    }

    // L-shape FilletRadius (inner re-entrant corner, adds material) and
    // EdgeRadius (leg toes, removes material) must be honoured — pre-fix the
    // section was a sharp 6-point polygon (~5% oversized convex hull on steel
    // angles, ISSUE_021 beams). L100/100/10 with FilletRadius=12, EdgeRadius=6.
    #[test]
    fn test_l_shape_honours_fillet_and_edge_radii() {
        let profile = process_content(
            "#1=IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,100.,10.,12.,6.,$,$,$);\n",
            1,
        );
        // Rounded corners => far more than the 6 sharp vertices.
        assert!(
            profile.outer.len() > 6,
            "fillets not generated: {} points",
            profile.outer.len()
        );
        // bbox is still Width × Depth (radii sit inside the legs).
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((max_x - min_x - 100.0).abs() < 1e-6, "width {}", max_x - min_x);
        assert!((max_y - min_y - 100.0).abs() < 1e-6, "height {}", max_y - min_y);
        // Closed-form area: sharp 1900 + inner fillet r1²(1−π/4) − two toe
        // edges 2·r2²(1−π/4) = 1900 + (144−72)(1−π/4) ≈ 1915.45 mm². The
        // 6-segment arc tessellation introduces a small inscribed-polygon error.
        let k = 1.0 - std::f64::consts::FRAC_PI_4;
        let expected = 1900.0 + (144.0 - 72.0) * k;
        let n = profile.outer.len();
        let mut area = 0.0;
        for i in 0..n {
            let a = profile.outer[i];
            let b = profile.outer[(i + 1) % n];
            area += a.x * b.y - b.x * a.y;
        }
        area = area.abs() * 0.5;
        assert!(
            (area - expected).abs() < 5.0,
            "L fillet area {area:.2} vs expected {expected:.2} — wrong fillet sign/placement"
        );
    }

    // A T-shape is centred on its bounding box: Y spans -Depth/2..+Depth/2,
    // not 0..Depth.
    #[test]
    fn test_t_shape_is_centered() {
        // Depth 100, FlangeWidth 80, WebThickness 10, FlangeThickness 12
        let profile = process_content(
            "#1=IFCTSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,12.,$,$,$,$,$);\n",
            1,
        );
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!((max_x - min_x - 80.0).abs() < 1e-9, "width should be FlangeWidth");
        assert!((max_y - min_y - 100.0).abs() < 1e-9, "height should be Depth");
    }

    // A C-shape (lipped channel) must span its full Width × Depth. Pre-fix
    // `process_c_shape` dropped the Width attribute (4) and used Girth (6) as
    // the X extent, so the channel came out only ~Girth wide.
    #[test]
    fn test_c_shape_spans_width_and_depth() {
        // Depth 200, Width 80, WallThickness 6, Girth 20.
        let profile = process_content(
            "#1=IFCCSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,6.,20.,$);\n",
            1,
        );
        let (min_x, min_y, max_x, max_y) = outer_bbox(&profile);
        assert!((min_x + max_x).abs() < 1e-9, "X not centred: {min_x}..{max_x}");
        assert!((min_y + max_y).abs() < 1e-9, "Y not centred: {min_y}..{max_y}");
        assert!(
            (max_x - min_x - 80.0).abs() < 1e-9,
            "width should be Width (80), got {}",
            max_x - min_x
        );
        assert!(
            (max_y - min_y - 200.0).abs() < 1e-9,
            "height should be Depth (200), got {}",
            max_y - min_y
        );
    }

    #[test]
    fn test_arbitrary_profile() {
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0));
#2=IFCCARTESIANPOINT((100.0,0.0));
#3=IFCCARTESIANPOINT((100.0,100.0));
#4=IFCCARTESIANPOINT((0.0,100.0));
#5=IFCPOLYLINE((#1,#2,#3,#4,#1));
#6=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#5);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(6).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 5); // 4 corners + closing point
        assert!(!profile.outer.is_empty());
    }

    #[test]
    fn test_derived_profile_applies_translation_rotation_and_scale() {
        let content = r#"
#1=IFCDIRECTION((0.0,1.0));
#2=IFCCARTESIANPOINT((10.0,20.0));
#3=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#1,$,#2,2.0);
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.0,4.0);
#5=IFCDERIVEDPROFILEDEF(.AREA.,$,#4,#3,$);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(5).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 4);
        assert!(profile.outer.contains(&Point2::new(14.0, 18.0)));
        assert!(profile.outer.contains(&Point2::new(14.0, 22.0)));
        assert!(profile.outer.contains(&Point2::new(6.0, 22.0)));
        assert!(profile.outer.contains(&Point2::new(6.0, 18.0)));
    }

    #[test]
    fn test_mirrored_profile_uses_derived_operator() {
        let content = r#"
#1=IFCDIRECTION((-1.0,0.0));
#2=IFCDIRECTION((0.0,1.0));
#3=IFCCARTESIANPOINT((0.0,0.0));
#4=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#1,#2,#3,1.0);
#5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.0,4.0);
#6=IFCMIRROREDPROFILEDEF(.AREA.,$,#5,#4,$);
"#;

        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);

        let profile_entity = decoder.decode_by_id(6).unwrap();
        let profile = processor
            .process(&profile_entity, &mut decoder, TessellationQuality::Medium)
            .unwrap();

        assert_eq!(profile.outer.len(), 4);
        assert!(profile.outer.contains(&Point2::new(1.0, -2.0)));
        assert!(profile.outer.contains(&Point2::new(-1.0, -2.0)));
        assert!(profile.outer.contains(&Point2::new(-1.0, 2.0)));
        assert!(profile.outer.contains(&Point2::new(1.0, 2.0)));
    }

    // ── trim_polyline / SweptDiskSolid trim-param coverage ────────────────────
    fn approx_eq_p3(a: Point3<f64>, b: Point3<f64>, tol: f64) -> bool {
        (a.x - b.x).abs() < tol && (a.y - b.y).abs() < tol && (a.z - b.z).abs() < tol
    }

    #[test]
    fn test_trim_polyline_full_range() {
        let pts = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
        ];
        let out = trim_polyline(&pts, 0.0, 1.0);
        assert_eq!(out.len(), 3);
        assert!(approx_eq_p3(out[0], pts[0], 1e-9));
        assert!(approx_eq_p3(out[1], pts[1], 1e-9));
        assert!(approx_eq_p3(out[2], pts[2], 1e-9));
    }

    #[test]
    fn test_trim_polyline_halves() {
        // 3 points evenly spaced from x=0 to x=2; trim to [0, 0.5] should give x ∈ [0, 1]
        let pts = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
            Point3::new(2.0, 0.0, 0.0),
        ];
        let first_half = trim_polyline(&pts, 0.0, 0.5);
        assert_eq!(first_half.len(), 2);
        assert!(approx_eq_p3(first_half[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(first_half[1], Point3::new(1.0, 0.0, 0.0), 1e-9));

        let second_half = trim_polyline(&pts, 0.5, 1.0);
        assert_eq!(second_half.len(), 2);
        assert!(approx_eq_p3(second_half[0], Point3::new(1.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(second_half[1], Point3::new(2.0, 0.0, 0.0), 1e-9));
    }

    #[test]
    fn test_trim_polyline_strict_interior() {
        // Trim [0.25, 0.75] over 5 evenly-spaced points (params 0, 0.25, 0.5, 0.75, 1)
        // Strict interior: only points at param 0.5 are added; boundaries are lerp'd.
        let pts: Vec<Point3<f64>> = (0..5)
            .map(|i| Point3::new(i as f64, 0.0, 0.0))
            .collect();
        let out = trim_polyline(&pts, 0.25, 0.75);
        // Expected: lerp(0.25)=x=1.0, mid=x=2.0, lerp(0.75)=x=3.0
        assert_eq!(out.len(), 3);
        assert!(approx_eq_p3(out[0], Point3::new(1.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(out[1], Point3::new(2.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(out[2], Point3::new(3.0, 0.0, 0.0), 1e-9));
    }

    #[test]
    fn test_trim_polyline_invalid_range() {
        let pts = vec![Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 0.0, 0.0)];
        // start >= end
        assert!(trim_polyline(&pts, 0.5, 0.5).is_empty());
        assert!(trim_polyline(&pts, 0.6, 0.4).is_empty());
        // too few points
        assert!(trim_polyline(&pts[..1], 0.0, 1.0).is_empty());
    }

    #[test]
    fn test_trim_polyline_two_points_partial() {
        let pts = vec![Point3::new(0.0, 0.0, 0.0), Point3::new(10.0, 0.0, 0.0)];
        let out = trim_polyline(&pts, 0.3, 0.7);
        assert_eq!(out.len(), 2);
        assert!(approx_eq_p3(out[0], Point3::new(3.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(out[1], Point3::new(7.0, 0.0, 0.0), 1e-9));
    }

    #[test]
    fn test_composite_curve_trim_first_segment_only() {
        // 3-segment composite curve along +Y, each segment 2.0 long
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,4.0,0.0));
#4=IFCCARTESIANPOINT((0.0,6.0,0.0));
#5=IFCPOLYLINE((#1,#2));
#6=IFCPOLYLINE((#2,#3));
#7=IFCPOLYLINE((#3,#4));
#8=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);
#9=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#6);
#10=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#7);
#11=IFCCOMPOSITECURVE((#8,#9,#10),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(11).unwrap();

        // [0,1] → first segment only → points (0,0,0) and (0,2,0)
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(1.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 2.0, 0.0), 1e-9));

        // [1,2] → middle segment only
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(1.0), Some(2.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 2.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 4.0, 0.0), 1e-9));

        // [0,3] → all three segments concatenated (4 points after de-dup)
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(3.0))
            .unwrap();
        assert_eq!(pts.len(), 4);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[3], Point3::new(0.0, 6.0, 0.0), 1e-9));
    }

    #[test]
    fn test_composite_curve_trim_clamps_out_of_range() {
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCPOLYLINE((#1,#2));
#4=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#3);
#5=IFCCOMPOSITECURVE((#4),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(5).unwrap();

        // Negative start clamps to 0
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(-5.0), Some(1.0))
            .unwrap();
        assert_eq!(pts.len(), 2);

        // End beyond num_segments clamps to num_segments
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(99.0))
            .unwrap();
        assert_eq!(pts.len(), 2);

        // start == end → empty
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.5), Some(0.5))
            .unwrap();
        assert!(pts.is_empty());

        // start > end → empty
        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.8), Some(0.2))
            .unwrap();
        assert!(pts.is_empty());
    }

    #[test]
    fn test_composite_curve_trim_fractional_multi_segment() {
        // 3-seg polyline along Y at 2.0 each; trim [0.5, 2.5] should yield
        // 2nd half of seg 0 + all of seg 1 + 1st half of seg 2:
        //   y = 1.0, 2.0, 4.0, 5.0
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,4.0,0.0));
#4=IFCCARTESIANPOINT((0.0,6.0,0.0));
#5=IFCPOLYLINE((#1,#2));
#6=IFCPOLYLINE((#2,#3));
#7=IFCPOLYLINE((#3,#4));
#8=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);
#9=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#6);
#10=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#7);
#11=IFCCOMPOSITECURVE((#8,#9,#10),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(11).unwrap();

        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.5), Some(2.5))
            .unwrap();
        // Expected: lerp into seg0 at 0.5 → y=1, end of seg0/start of seg1 → y=2 (kept once),
        // end of seg1/start of seg2 → y=4 (kept once), lerp into seg2 at 0.5 → y=5
        let ys: Vec<f64> = pts.iter().map(|p| p.y).collect();
        assert_eq!(ys.len(), 4, "got points: {:?}", pts);
        assert!((ys[0] - 1.0).abs() < 1e-9);
        assert!((ys[1] - 2.0).abs() < 1e-9);
        assert!((ys[2] - 4.0).abs() < 1e-9);
        assert!((ys[3] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn test_polyline_trim_first_segment() {
        // 4-point polyline along Y: (0,0,0)→(0,2,0)→(0,4,0)→(0,6,0)
        // Parameter range is [0, 3]. Trim [0,1] = first segment only.
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,4.0,0.0));
#4=IFCCARTESIANPOINT((0.0,6.0,0.0));
#5=IFCPOLYLINE((#1,#2,#3,#4));
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(5).unwrap();

        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(0.0), Some(1.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 2.0, 0.0), 1e-9));

        // Trim [1, 2] = middle segment
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(1.0), Some(2.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 2.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 4.0, 0.0), 1e-9));

        // Trim [0.5, 2.5] = half + full + half across 3 segments
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(0.5), Some(2.5))
            .unwrap();
        let ys: Vec<f64> = pts.iter().map(|p| p.y).collect();
        assert_eq!(ys.len(), 4, "got points: {:?}", pts);
        assert!((ys[0] - 1.0).abs() < 1e-9);
        assert!((ys[1] - 2.0).abs() < 1e-9);
        assert!((ys[2] - 4.0).abs() < 1e-9);
        assert!((ys[3] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn test_polyline_trim_clamps_and_inverts() {
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCPOLYLINE((#1,#2));
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(3).unwrap();

        // No params → full polyline
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, None, None)
            .unwrap();
        assert_eq!(pts.len(), 2);

        // Inverted → empty
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(0.8), Some(0.2))
            .unwrap();
        assert!(pts.is_empty());

        // Out-of-range clamps
        let pts = processor
            .get_polyline_points_trimmed(&curve, &mut decoder, Some(-5.0), Some(99.0))
            .unwrap();
        assert_eq!(pts.len(), 2);
    }

    #[test]
    fn test_composite_curve_trim_keeps_non_coincident_junction() {
        // Two segments whose endpoints don't coincide at the boundary
        // (a real-world artefact: model drift, mismatched cartesian points).
        // seg 0: (0,0,0)→(0,2,0); seg 1: (0,2.5,0)→(0,4.5,0).
        // Concatenating segments [0,2] must preserve all 4 distinct points —
        // dropping the first point of seg 1 would erase the gap and bend the
        // directrix.
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,2.0,0.0));
#3=IFCCARTESIANPOINT((0.0,2.5,0.0));
#4=IFCCARTESIANPOINT((0.0,4.5,0.0));
#5=IFCPOLYLINE((#1,#2));
#6=IFCPOLYLINE((#3,#4));
#7=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#5);
#8=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#6);
#9=IFCCOMPOSITECURVE((#7,#8),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(9).unwrap();

        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(2.0))
            .unwrap();
        assert_eq!(pts.len(), 4, "got points: {:?}", pts);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 0.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 2.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[2], Point3::new(0.0, 2.5, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[3], Point3::new(0.0, 4.5, 0.0), 1e-9));
    }

    #[test]
    fn test_composite_curve_trim_same_sense_false() {
        // Single segment with SameSense=F should reverse before trim.
        // Polyline (0,0,0)→(0,10,0) reversed = (0,10,0)→(0,0,0).
        // Trim [0, 0.3] of reversed → first 30% of reversed → from y=10 to y=7.
        let content = r#"
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((0.0,10.0,0.0));
#3=IFCPOLYLINE((#1,#2));
#4=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#3);
#5=IFCCOMPOSITECURVE((#4),.F.);
"#;
        let mut decoder = EntityDecoder::new(content);
        let schema = IfcSchema::new();
        let processor = ProfileProcessor::new(schema);
        let curve = decoder.decode_by_id(5).unwrap();

        let pts = processor
            .get_composite_curve_points_trimmed(&curve, &mut decoder, Some(0.0), Some(0.3))
            .unwrap();
        assert_eq!(pts.len(), 2);
        assert!(approx_eq_p3(pts[0], Point3::new(0.0, 10.0, 0.0), 1e-9));
        assert!(approx_eq_p3(pts[1], Point3::new(0.0, 7.0, 0.0), 1e-9));
    }
}
