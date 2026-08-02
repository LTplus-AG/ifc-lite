// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Triangle–triangle intersection machinery — exact, predicate-driven.
//!
//! Classifies a triangle against another's plane (via exact `orient3d`) and
//! constructs the edge∩plane intersection points as LPI implicit points. The
//! full intersection segment (interval overlap along the planes' crossing
//! line) and the in-plane re-triangulation build on this.
//!
//! Every intersection point is an LPI carried symbolically over the original
//! input coordinates — never materialised — so downstream predicates stay exact
//! and platform-deterministic.

use super::predicates::orient3d;
use super::{ImplicitPoint, Lpi, Sign};

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

/// The implicit point where edge `a→b` crosses the plane through `plane`.
#[inline]
pub fn edge_plane_lpi(a: [f64; 3], b: [f64; 3], plane: &[[f64; 3]; 3]) -> Lpi {
    Lpi { p: a, q: b, r: plane[0], s: plane[1], t: plane[2] }
}

/// For a `Crosses { apex }` triangle, the two LPI points where the apex's two
/// edges cross `plane` — the triangle's interval endpoints on the crossing line.
pub fn crossing_lpis(tri: &[[f64; 3]; 3], apex: usize, plane: &[[f64; 3]; 3]) -> [Lpi; 2] {
    let o1 = (apex + 1) % 3;
    let o2 = (apex + 2) % 3;
    [
        edge_plane_lpi(tri[apex], tri[o1], plane),
        edge_plane_lpi(tri[apex], tri[o2], plane),
    ]
}

#[inline]
fn sub_f64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn cross_f64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn plane_normal(t: &[[f64; 3]; 3]) -> [f64; 3] {
    cross_f64(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]))
}
/// Approximate direction of the crossing line L = t1.plane ∩ t2.plane (n1 × n2),
/// rounded to an INTEGER-valued direction. The raw cross product lands on a ~2^64
/// grid (cross of 2^32 vectors) — off the 2^16 snap grid — so `gi(u)` fails and
/// EVERY `cmp_along` falls into slow BigRational. Only the SIGN of `(a−b)·u`
/// matters and `u` need only be approximately along L, so we normalise + round to
/// integers: `gi` then scales it on-grid and the exact fixed-width tier resolves
/// the 1-D ordering. (~600µs/intersection → microseconds.)
fn line_direction(t1: &[[f64; 3]; 3], t2: &[[f64; 3]; 3]) -> [f64; 3] {
    let n = cross_f64(plane_normal(t1), plane_normal(t2));
    let m = n[0].abs().max(n[1].abs()).max(n[2].abs());
    if m == 0.0 || !m.is_finite() {
        return n;
    }
    let s = 1_048_576.0 / m; // normalise the max component to ~2^20
    [(n[0] * s).round(), (n[1] * s).round(), (n[2] * s).round()]
}

/// Result of an exact triangle–triangle intersection test.
#[derive(Clone, Debug)]
pub enum TriTri {
    /// No intersection.
    None,
    /// The triangles are coplanar (a 2D-overlap case — handled in `coplanar.rs`).
    Coplanar,
    /// Contact at a single point (a vertex touch) — no cutting segment.
    Point(ImplicitPoint),
    /// The intersection segment; endpoints lie on line L = plane(T1) ∩ plane(T2).
    /// An endpoint is `Explicit` (an on-plane vertex) or `Lpi` (an edge crossing).
    Segment([ImplicitPoint; 2]),
}

#[inline]
fn cmp_along(a: &ImplicitPoint, b: &ImplicitPoint, u: [f64; 3]) -> Sign {
    // f64 interval filter FIRST (pure f64), then the exact I512 tier, then
    // BigRational. The interval resolves the non-degenerate majority off the
    // wasm-emulated wide-integer path; a definite interval sign equals the exact
    // sign (outward rounding, no FMA) ⇒ identical ordering, byte-identical.
    super::interval::cmp_along(a, b, u)
        .or_else(|| super::fixed::cmp_along(a, b, u))
        .unwrap_or_else(|| super::rational::cmp_along(a, b, u))
}

/// A triangle's intersection with another triangle's supporting plane — the
/// generalisation that admits on-plane vertices (Touches), not just clean
/// edge crossings. Every endpoint lies on BOTH planes ⇒ on line L.
enum PlaneInterval {
    /// Triangle strictly on one side — no plane intersection.
    None,
    /// Triangle lies in the plane.
    Coplanar,
    /// Touches the plane at a single vertex only (no chord).
    Point(ImplicitPoint),
    /// A chord (2 on-plane endpoints): 2 edge crossings, vertex + edge crossing,
    /// or an on-plane edge.
    Chord([ImplicitPoint; 2]),
}

fn plane_interval(tri: &[[f64; 3]; 3], plane: &[[f64; 3]; 3]) -> PlaneInterval {
    let s = [
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[0])),
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[1])),
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[2])),
    ];
    let zeros: Vec<usize> = (0..3).filter(|&i| s[i] == Sign::Zero).collect();
    match zeros.len() {
        3 => PlaneInterval::Coplanar,
        2 => PlaneInterval::Chord([e(tri[zeros[0]]), e(tri[zeros[1]])]), // an on-plane edge
        1 => {
            let vz = zeros[0];
            let (o1, o2) = ((vz + 1) % 3, (vz + 2) % 3);
            if s[o1] == s[o2] {
                PlaneInterval::Point(e(tri[vz])) // both others same side: single vertex touch
            } else {
                // the far edge crosses: chord [on-plane vertex, edge∩plane]
                PlaneInterval::Chord([e(tri[vz]), ImplicitPoint::Lpi(edge_plane_lpi(tri[o1], tri[o2], plane))])
            }
        }
        _ => {
            let pos = s.iter().filter(|&&x| x == Sign::Positive).count();
            if pos == 0 || pos == 3 {
                PlaneInterval::None
            } else {
                let apex = if s[0] != s[1] && s[0] != s[2] {
                    0
                } else if s[1] != s[0] && s[1] != s[2] {
                    1
                } else {
                    2
                };
                let [a, b] = crossing_lpis(tri, apex, plane);
                PlaneInterval::Chord([ImplicitPoint::Lpi(a), ImplicitPoint::Lpi(b)])
            }
        }
    }
}

/// Near-coplanar band formula, canonical in `mesh_bridge` (sized to the
/// snap-scatter envelope `mesh_bridge::mesh_to_tris` produces).
use super::mesh_bridge::near_band_from_extent;

#[inline]
fn ti_sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn ti_cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn ti_dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn ti_normal(t: &[[f64; 3]; 3]) -> [f64; 3] {
    ti_cross(ti_sub(t[1], t[0]), ti_sub(t[2], t[0]))
}

/// Are `t1` and `t2` an INTENDED-FLUSH coplanar pair that per-axis snapping
/// pushed just off exact coplanarity? — the flush-cap detector.
///
/// `mesh_bridge` snaps every operand coordinate to [`SNAP_GRID`] INDEPENDENTLY
/// per axis. That keeps an AXIS-ALIGNED flush face exactly coplanar but pushes a
/// *tilted* flush face up to `SNAP_GRID·√3` off its plane PER OPERAND — so a roof-
/// slope opening cap authored EXACTLY flush with the slanted roof surface lands a
/// few µm off after import (#1007 host #1112 openings #2150/#2154). The exact
/// `orient3d`-only test then sees it as a razor-thin CROSSING (or Disjoint), never
/// `Coplanar`, so the footprint is never carved and a sliver bridges the hole.
///
/// The test is ONE deterministic FMA-free f64 condition (byte-identical
/// native==wasm — NO coordinate is moved, this is purely a CLASSIFICATION):
/// **the noise-slab test** — ALL THREE vertices of one triangle sit within
/// `band` of the other triangle's plane (either direction qualifies). A facet
/// entirely inside the other face's snap-scatter slab is geometrically
/// indistinguishable from lying ON that face, so it must be routed to the exact
/// coplanar handler. A genuine transversal cut (box−box, every real crossing)
/// has vertices FAR off the other plane ⇒ fails the slab test.
///
/// WHY vertex-slab and not the earlier fixed angle gate: the old formulation
/// ALSO required the two plane normals to agree to ~2^-20 (≈1.4 mrad) — but
/// the tilt that f32 import noise induces on an intended-flush facet scales as
/// `scatter / edge_length`. At 300–400 m from origin (f32 ULP 30.5 µm —
/// tunnel-alignment walls) a SMALL flush facet (0.03–0.05 m edges, 3-segment
/// recess cutters) tilts 1.4–1.9 mrad: past the fixed gate while sitting
/// 3–24 µm INSIDE the slab. The missed pair then enters the razor-thin-
/// crossing path whose degenerate sub-triangle keep/drop is a noise lottery →
/// open edges + volumes off by −85%…+19 763% (a 749-element divergence family,
/// ~84% adjudicated PURE-WRONG against IfcOpenShell 0.8.2). The slab test is
/// scale-correct: small facets get exactly the angular allowance their size
/// implies, large facets proportionally less (a large tilted partner's far
/// vertices leave the slab, so it still fails).
///
/// `band` is an absolute power-of-two multiple of `SNAP_GRID` (≈ the 2-operand
/// scatter envelope, ~0.12 mm) widened only for far-from-origin operands where
/// f32 import is coarser — always THREE orders below the smallest real feature
/// edge (~0.2 m). A poke-through cap fails the slab test (its far vertices sit
/// midway through the host, far from the surface) so it can never qualify; a
/// sub-band-sized transversal micro-sliver CAN now qualify, but its entire
/// geometric effect is below the import-noise floor by construction, and the
/// coplanar overlay's degenerate-projection guards (`w0 == Zero`) handle it.
fn near_coplanar(t1: &[[f64; 3]; 3], t2: &[[f64; 3]; 3]) -> bool {
    let (n1, n2) = (ti_normal(t1), ti_normal(t2));
    let (nn1, nn2) = (ti_dot(n1, n1), ti_dot(n2, n2));
    if nn1 <= 0.0 || nn2 <= 0.0 || !nn1.is_finite() || !nn2.is_finite() {
        return false; // a degenerate triangle is never a flush coplanar partner
    }
    let mut extent = 1.0f64;
    for p in t1.iter().chain(t2.iter()) {
        for &c in p {
            extent = extent.max(c.abs());
        }
    }
    let band = near_band_from_extent(extent); // 2^-22
    let band2 = band * band;
    // All three vertices of `t` within `band` of `plane`'s supporting plane?
    let in_slab = |t: &[[f64; 3]; 3], plane: &[[f64; 3]; 3], n: [f64; 3], nn: f64| {
        t.iter().all(|&v| {
            let d = ti_dot(ti_sub(v, plane[0]), n); // perp_dist · |n|
            (d * d) / nn <= band2
        })
    };
    in_slab(t2, t1, n1, nn1) || in_slab(t1, t2, n2, nn2)
}

/// Exact triangle–triangle intersection: the overlap of each triangle's
/// plane-interval along line L = `[max(lo1,lo2), min(hi1,hi2)]`. Handles clean
/// crossings AND Touches (on-plane vertices/edges). Coplanar is deferred to
/// `coplanar.rs`; a single shared point returns `Point` (no cut).
pub fn tri_tri_intersection(t1: &[[f64; 3]; 3], t2: &[[f64; 3]; 3]) -> TriTri {
    use PlaneInterval as PI;
    // Near-coplanar guard (the flush-cap fix): an intended-flush coplanar
    // interface that per-axis snapping pushed just off exact coplanarity is
    // routed to the exact coplanar handler so the footprint is carved (otherwise
    // a sliver bridges the opening). See `near_coplanar`.
    if near_coplanar(t1, t2) {
        return TriTri::Coplanar;
    }
    let (i1, i2) = (plane_interval(t1, t2), plane_interval(t2, t1));
    let ends = |pi: &PI| -> Option<[ImplicitPoint; 2]> {
        match pi {
            PI::Point(p) => Some([p.clone(), p.clone()]),
            PI::Chord([a, b]) => Some([a.clone(), b.clone()]),
            _ => None,
        }
    };
    if matches!(i1, PI::Coplanar) || matches!(i2, PI::Coplanar) {
        return TriTri::Coplanar;
    }
    let ([a1, b1], [a2, b2]) = match (ends(&i1), ends(&i2)) {
        (Some(s1), Some(s2)) => (s1, s2),
        _ => return TriTri::None,
    };
    let u = line_direction(t1, t2);
    let order = |a: ImplicitPoint, b: ImplicitPoint| {
        if cmp_along(&a, &b, u) == Sign::Positive {
            (b, a)
        } else {
            (a, b)
        }
    };
    let (lo1, hi1) = order(a1, b1);
    let (lo2, hi2) = order(a2, b2);
    let lo = if cmp_along(&lo1, &lo2, u) == Sign::Positive { lo1 } else { lo2 };
    let hi = if cmp_along(&hi1, &hi2, u) == Sign::Negative { hi1 } else { hi2 };
    match cmp_along(&lo, &hi, u) {
        Sign::Positive => TriTri::None,           // intervals disjoint
        Sign::Zero => TriTri::Point(lo),          // a single shared point
        Sign::Negative => TriTri::Segment([lo, hi]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZPLANE: [[f64; 3]; 3] = [[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]]; // z = 0

    #[test]
    fn edge_crossing_lpi_lies_exactly_on_the_plane() {
        // The defining property: orient3d(LPI, plane[0], plane[1], plane[2]) == 0
        // (the edge∩plane point is coplanar with the plane). This ties the LPI
        // construction to the exact LPI-orient3d predicate.
        let lpi = edge_plane_lpi([0.5, 0.5, -1.], [0.5, 0.5, 3.], &ZPLANE);
        assert_eq!(
            orient3d(&ImplicitPoint::Lpi(lpi), &e(ZPLANE[0]), &e(ZPLANE[1]), &e(ZPLANE[2])),
            Sign::Zero,
            "edge∩plane LPI is not exactly on the plane"
        );
        // tilted plane + tilted edge
        let tilted = [[0., 0., 1.], [3., 0., 2.], [0., 3., 2.]];
        let lpi2 = edge_plane_lpi([1., 1., 0.], [1.5, 0.5, 5.], &tilted);
        assert_eq!(
            orient3d(&ImplicitPoint::Lpi(lpi2), &e(tilted[0]), &e(tilted[1]), &e(tilted[2])),
            Sign::Zero,
            "tilted edge∩plane LPI is not exactly on the plane"
        );
    }

    #[test]
    fn proper_crossing_yields_segment_on_both_planes() {
        let t1 = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // plane y=0
        let t2 = [[1., -2., 1.], [1., 2., 1.], [1., 0.5, -3.]]; // plane x=1
        match tri_tri_intersection(&t1, &t2) {
            TriTri::Segment([a, b]) => {
                // The two endpoints are distinct (a non-degenerate segment).
                assert_ne!(
                    super::cmp_along(&a, &b, super::line_direction(&t1, &t2)),
                    Sign::Zero,
                    "segment collapsed to a point"
                );
                // Every segment endpoint lies on BOTH triangles' planes (on L).
                for ep in [&a, &b] {
                    assert_eq!(
                        orient3d(ep, &e(t1[0]), &e(t1[1]), &e(t1[2])),
                        Sign::Zero,
                        "segment endpoint off t1's plane"
                    );
                    assert_eq!(
                        orient3d(ep, &e(t2[0]), &e(t2[1]), &e(t2[2])),
                        Sign::Zero,
                        "segment endpoint off t2's plane"
                    );
                }
            }
            other => panic!("expected a segment, got {other:?}"),
        }
    }

    #[test]
    fn touches_vertex_on_plane_yields_segment_with_explicit_endpoint() {
        // t2 crosses t1's plane (y=0) but with ONE vertex EXACTLY on it.
        let t1 = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // plane y=0
        let t2 = [[0., 0., 0.5], [0.5, -1., 0.5], [0.5, 1., 0.5]]; // v0 at y=0, in plane z=0.5
        match tri_tri_intersection(&t1, &t2) {
            TriTri::Segment([a, b]) => {
                // exactly one endpoint is the Explicit on-plane vertex (0,0,0.5)
                let explicits = [&a, &b]
                    .iter()
                    .filter(|p| matches!(p, ImplicitPoint::Explicit(_)))
                    .count();
                assert_eq!(explicits, 1, "expected one Explicit (on-plane vertex) endpoint");
                // both endpoints lie on BOTH planes (on L)
                for ep in [&a, &b] {
                    assert_eq!(orient3d(ep, &e(t1[0]), &e(t1[1]), &e(t1[2])), Sign::Zero);
                    assert_eq!(orient3d(ep, &e(t2[0]), &e(t2[1]), &e(t2[2])), Sign::Zero);
                }
            }
            other => panic!("Touches case should yield a Segment, got {other:?}"),
        }
    }

    #[test]
    fn planes_cross_but_intervals_disjoint_is_none() {
        let t1 = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // y=0, crosses x=1 at z∈[-1,0.5]
        let t2 = [[1., -2., 5.], [1., 2., 5.], [1., 0.5, 9.]]; // x=1, crosses y=0 at z∈[5,8.2]
        // both planes DO cross (checked via tri_tri_intersection's own plane_interval
        // path below); the disjoint-intervals-along-L outcome is the real assertion.
        assert!(
            matches!(tri_tri_intersection(&t1, &t2), TriTri::None),
            "disjoint intervals along L should give no intersection"
        );
    }
}
