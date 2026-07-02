// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::profile::Profile2D;
use crate::Point2;

/// Issue #635 — when an `IfcArbitraryClosedProfileDef` is actually a smooth
/// curve approximated by a many-vertex polyline (e.g. a 127-vertex circle
/// stand-in for a round window), the resulting prism had too many side
/// triangles for the (since-deleted) BSP CSG polygon budget and the void cut
/// fell back to an axis-aligned box, turning round windows into squares.
/// The downsample is kept: it still makes curved void cuts dramatically
/// cheaper on the exact kernel.
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
pub(super) fn mirror_profile_about_y_axis(profile: &mut Profile2D) {
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
pub(super) fn simplify_smooth_curve_polyline(points: &[Point2<f64>]) -> Vec<Point2<f64>> {
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
    //    ellipse simplifies perfectly and *must* keep simplifying to keep its
    //    void cut cheap (issue #635 history: overflowing the deleted BSP
    //    polygon budget turned round openings into AABB boxes).
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
}
