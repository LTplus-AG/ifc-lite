// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3353: a union of two overlapping boxes, one rotated 30 degrees about
//! Z, tears whenever the pair's horizontal faces sit a FEW SNAP STEPS apart
//! instead of exactly flush.
//!
//! ## The smallest reproduction
//!
//! `a_rotated_corner_overlap_one_snap_off_stays_closed` is the whole defect in
//! two unit boxes: A at the origin, B rotated 30 degrees about Z overlapping
//! A's +X+Y corner, B's Z span offset by exactly ONE `SNAP_GRID` step
//! (`1/65536`). On `main` that union came back with 13 unmatched directed
//! edges. Move the offset to zero and it is clean; move it to a quarter of a
//! metre and it is clean. Only the few-microns-off regime tears, which is what
//! names the mechanism.
//!
//! ## The mechanism
//!
//! `mesh_bridge` snaps each operand's coordinates to `SNAP_GRID` per axis, so
//! two faces authored flush routinely land a snap step apart. Three kernel
//! stages then have to decide whether that pair is ONE surface or two, and
//! they did not decide alike:
//!
//! * `broadphase::candidate_pairs` compares AABBs EXACTLY. Two parallel faces
//!   one snap step apart have disjoint boxes, so the pair never reached
//!   `tri_tri_intersection` and `near_coplanar`'s flush-cap guard never ran.
//!   No coplanar constraint was emitted, so nothing conformed the two faces.
//!   (Measured, not read off the code: padding the broadphase query by the
//!   `NearBand` on its own took the pinned case from 13 unmatched edges to 3.)
//! * `classify.rs`'s regime 1 used a `NearBand` (floor `8 * SNAP_GRID`) and
//!   DID call the pair a coincident shared face. It kept A's copy on normal
//!   agreement.
//! * The matching B copy was kept too: its own sub-triangle centroids project
//!   OUTSIDE A's footprint (A's walls stop below B's top face, so the
//!   arrangement never split it), so `c_on_or_near_a` returned false and the
//!   plain ray cast kept it as genuinely outside A.
//!
//! Two unconformed, near-parallel faces both survive. The union grows a
//! doubled roof one snap step thick, and the rim of B's side walls between the
//! two heights has nothing to close against.
//!
//! ## The fix
//!
//! `union_with_conformity` now runs `promote_cutter_verts_onto_host_faces`
//! before the arrangement, exactly as `subtract`/`subtract_many` already did:
//! a B vertex within the `NearBand` of an A face plane is welded EXACTLY onto
//! that plane. The near-coplanar pair becomes an exactly-coplanar pair, the
//! exact coplanar carve fires, and every stage downstream agrees because there
//! is no longer anything to disagree about — including the broadphase, whose
//! exact AABB test is now correct rather than merely tolerable. This is why
//! the fix lives in the snap path and not in the classifier: the classifier
//! cannot conform a pair the arrangement never saw.
//!
//! Refs #3353

use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::HashMap;

/// `mesh_bridge::SNAP_GRID`, mirrored because it is `pub(crate)`. The tear is
/// scaled to this constant, not to an arbitrary epsilon, so a change to the
/// grid must be reflected here for the fixture to keep pinning the same regime.
const SNAP_GRID: f64 = 1.0 / 65536.0;

/// Outward-wound axis-aligned box, optionally rigidly rotated about `about`.
fn boxed(min: [f64; 3], size: [f64; 3], rot: Option<(Vector3<f64>, f64, [f64; 3])>) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let mut corners: Vec<Point3<f64>> = [
        (0, 0, 0),
        (1, 0, 0),
        (1, 1, 0),
        (0, 1, 0),
        (0, 0, 1),
        (1, 0, 1),
        (1, 1, 1),
        (0, 1, 1),
    ]
    .iter()
    .map(|&(i, j, k)| Point3::new(c(0)[i], c(1)[j], c(2)[k]))
    .collect();
    if let Some((axis, angle, about)) = rot {
        let r = Rotation3::from_axis_angle(&Unit::new_normalize(axis), angle);
        let o = Point3::new(about[0], about[1], about[2]);
        for p in corners.iter_mut() {
            *p = o + r * (*p - o);
        }
    }
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for f in &faces {
        let e1 = corners[f[1]] - corners[f[0]];
        let e2 = corners[f[2]] - corners[f[0]];
        let n = e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z());
        let b = m.vertex_count() as u32;
        for &i in f {
            m.add_vertex(corners[i], n);
        }
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// Watertightness, counting the two directions SEPARATELY after welding by
/// position at 0.1 mm — the same census check `issue_3353_boolean_tear.rs` and
/// `issue_3353_sweep_261_classification_tear.rs` use. A net-signed tally can
/// cancel a real non-manifold seam to zero, so every undirected edge must be
/// used exactly once forward and once reverse.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        return Err("host was deleted entirely".to_string());
    }
    let welded = m.welded_by_position(1e-4);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if a == b {
                return Err(format!("degenerate edge: triangle repeats welded vertex {a}"));
            }
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    Ok(edges.values().filter(|&&(f, r)| f != 1 || r != 1).count())
}


/// Signed volume by the divergence theorem, in the mesh's own units.
///
/// # Why the open-edge count alone is not enough
///
/// `csg/union.rs` falls back to a PLAIN MERGE of the two operands when the
/// kernel result looks invalid: it returns `A + B` with the overlap left in.
/// That mesh is perfectly closed — every edge of each box is still paired — so
/// the watertightness oracle passes it, at volume 2.0 where the real union is
/// about 1.75. An open-edge assertion on its own therefore cannot tell "the
/// kernel produced a correct union" from "the kernel gave up". The volume can.
fn mesh_volume(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = (i as usize) * 3;
        [
            f64::from(m.positions[b]),
            f64::from(m.positions[b + 1]),
            f64::from(m.positions[b + 2]),
        ]
    };
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let (p, q, r) = (v(t[0]), v(t[1]), v(t[2]));
            let cr = [
                q[1] * r[2] - q[2] * r[1],
                q[2] * r[0] - q[0] * r[2],
                q[0] * r[1] - q[1] * r[0],
            ];
            (p[0] * cr[0] + p[1] * cr[1] + p[2] * cr[2]) / 6.0
        })
        .sum::<f64>()
        .abs()
}

/// The union's volume computed WITHOUT the kernel, so the assertion has an
/// independent oracle rather than one derived from the thing under test.
///
/// Both operands are vertical prisms (the only rotation is about Z), so
/// `|A ∪ B| = |A| + |B| − area(footprint_A ∩ footprint_B) · z-overlap`. The
/// footprints are convex quads, so the intersection is one Sutherland-Hodgman
/// clip and the shoelace of the result.
fn expected_union_volume(dx: f64, dy: f64, z_offset: f64, b_height: f64) -> f64 {
    let ang = 30.0f64.to_radians();
    let (c, sn) = (ang.cos(), ang.sin());
    let about = [dx + 0.5, dy + 0.5];
    let b_foot: Vec<[f64; 2]> = [
        [dx, dy],
        [dx + 1.0, dy],
        [dx + 1.0, dy + 1.0],
        [dx, dy + 1.0],
    ]
    .iter()
    .map(|p| {
        let (ux, uy) = (p[0] - about[0], p[1] - about[1]);
        [about[0] + ux * c - uy * sn, about[1] + ux * sn + uy * c]
    })
    .collect();

    // Sutherland-Hodgman: clip A's unit-square footprint by each of B's edges.
    let mut poly: Vec<[f64; 2]> = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    for i in 0..b_foot.len() {
        let (p0, p1) = (b_foot[i], b_foot[(i + 1) % b_foot.len()]);
        let side = |p: [f64; 2]| (p1[0] - p0[0]) * (p[1] - p0[1]) - (p1[1] - p0[1]) * (p[0] - p0[0]);
        let mut out: Vec<[f64; 2]> = Vec::new();
        for j in 0..poly.len() {
            let (cur, prev) = (poly[j], poly[(j + poly.len() - 1) % poly.len()]);
            let (sc, sp) = (side(cur), side(prev));
            if sc >= 0.0 {
                if sp < 0.0 {
                    let t = sp / (sp - sc);
                    out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
                }
                out.push(cur);
            } else if sp >= 0.0 {
                let t = sp / (sp - sc);
                out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
            }
        }
        poly = out;
        if poly.is_empty() {
            break;
        }
    }
    let area = (0..poly.len())
        .map(|i| {
            let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
            p[0] * q[1] - q[0] * p[1]
        })
        .sum::<f64>()
        .abs()
        / 2.0;
    let z_overlap = (1.0f64.min(z_offset + b_height) - 0.0f64.max(z_offset)).max(0.0);
    1.0 + b_height - area * z_overlap
}

/// Tolerance on the volume. The weld moves vertices by at most a snap step, so
/// a face of area ~1 can shift its contribution by ~`SNAP_GRID`; over the six
/// faces of each operand that is ~1e-4. 1e-3 clears that by an order of
/// magnitude and is still three orders below the 0.25 m³ gap between a real
/// union and the plain-merge fallback this is here to catch.
const VOLUME_TOL: f64 = 1.0e-3;

fn volume_complaint(out: &Mesh, expected: f64, merged: f64, what: &str) -> Option<String> {
    let v = mesh_volume(out);
    if (v - expected).abs() >= VOLUME_TOL {
        // The plain-merge fallback is called out by name, because it is the
        // specific wrong answer the open-edge oracle used to accept.
        let how = if (v - merged).abs() < VOLUME_TOL {
            " - this is exactly the plain-merge fallback, so the kernel gave up"
        } else {
            ""
        };
        return Some(format!("{what}: union volume {v}, expected {expected}{how}"));
    }
    None
}

/// A unit box at the origin, and a unit box rotated 30 degrees about Z placed
/// so it overlaps the first one's `+X+Y` corner, with `z_offset` added to the
/// rotated box's Z span.
fn corner_overlap_pair(dx: f64, dy: f64, z_offset: f64, b_height: f64) -> (Mesh, Mesh) {
    let a = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    let b_min = [dx, dy, z_offset];
    let about = [b_min[0] + 0.5, b_min[1] + 0.5, b_min[2] + b_height / 2.0];
    let b = boxed(
        b_min,
        [1.0, 1.0, b_height],
        Some((Vector3::z(), 30.0f64.to_radians(), about)),
    );
    (a, b)
}

/// Both operand orders, because the weld that fixes this is keyed to argument
/// position unless it is applied mutually: with the one-directional form
/// `union_mesh(a, b)` came back closed while `union_mesh(b, a)` on the same
/// two meshes still had 8 unmatched directed edges.
fn assert_union_is_closed(z_offset: f64, b_height: f64, what: &str) {
    let (a, b) = corner_overlap_pair(0.5, 0.5, z_offset, b_height);
    assert_eq!(open_edges(&a), Ok(0), "operand A must be closed going in");
    assert_eq!(open_edges(&b), Ok(0), "operand B must be closed going in");
    let clipper = ClippingProcessor::new();
    let forward = clipper.union_mesh(&a, &b).expect("union must not error");
    let reversed = clipper.union_mesh(&b, &a).expect("union must not error");
    assert_eq!(
        open_edges(&forward),
        Ok(0),
        "a closed-in operand pair must come back closed-out ({what}, A then B)"
    );
    assert_eq!(
        open_edges(&reversed),
        Ok(0),
        "a closed-in operand pair must come back closed-out ({what}, B then A)"
    );
    let expected = expected_union_volume(0.5, 0.5, z_offset, b_height);
    let merged = 1.0 + b_height;
    for (order, out) in [("A then B", &forward), ("B then A", &reversed)] {
        if let Some(c) = volume_complaint(out, expected, merged, &format!("{what}, {order}")) {
            panic!("{c}");
        }
    }
}

/// The pinned minimum: ONE snap step of Z offset. 13 unmatched directed edges
/// before the fix.
#[test]
fn a_rotated_corner_overlap_one_snap_off_stays_closed() {
    assert_union_is_closed(SNAP_GRID, 1.0, "+1 snap step, full-height B");
}

/// The two neighbouring regimes the offset sweep separates, kept as anchors so
/// a future change cannot "fix" the near-coplanar case by breaking the exactly
/// flush one or the plainly transversal one.
#[test]
fn the_exactly_flush_and_plainly_transversal_neighbours_stay_closed() {
    assert_union_is_closed(0.0, 1.0, "exactly flush Z faces");
    assert_union_is_closed(0.25, 1.0, "Z faces a quarter metre apart");
}

/// The tear was never specific to one offset, one sign, one face pairing or one
/// operand order: on `main` this swept 4732 pairs and 2090 tore with A first,
/// 2388 with B first. It is the property the fix has to hold, so it is asserted
/// rather than described.
///
/// Kept small enough to run in the default lane (a few seconds in debug): 7
/// offsets from -3 to +3 snap steps, 4 Z layouts (bottom faces near-flush, top
/// faces near-flush, B contained, B plainly transversal), 169 corner overlaps
/// each, both operand orders.
#[test]
fn no_offset_within_the_snap_band_tears_the_corner_overlap() {
    let clipper = ClippingProcessor::new();
    let mut torn: Vec<String> = Vec::new();
    for steps in -3i32..=3 {
        let dz = f64::from(steps) * SNAP_GRID;
        for &(b_z, b_h) in &[(0.0, 1.0), (0.5, 0.5), (0.0, 0.5), (0.25, 1.0)] {
            for i in 0..13 {
                for j in 0..13 {
                    let (dx, dy) = (0.5 + f64::from(i) * 0.04, 0.5 + f64::from(j) * 0.04);
                    // The SAME builder the single-case assertions use, so the
                    // sweep cannot drift away from the pinned fixtures.
                    let (a, b) = corner_overlap_pair(dx, dy, b_z + dz, b_h);
                    // BOTH orders: `a ∪ b` and `b ∪ a` are the same solid, and
                    // on `main` the two orders tore 2090 and 2388 times here.
                    let expected = expected_union_volume(dx, dy, b_z + dz, b_h);
                    let merged = 1.0 + b_h;
                    for (order, out) in [
                        ("A then B", clipper.union_mesh(&a, &b)),
                        ("B then A", clipper.union_mesh(&b, &a)),
                    ] {
                        let out = out.expect("union must not error");
                        let here = format!("steps={steps} b_z={b_z} b_h={b_h} dx={dx} dy={dy} {order}");
                        if let other @ (Ok(1..) | Err(_)) = open_edges(&out) {
                            torn.push(format!("{here}: {other:?}"));
                        }
                        if let Some(c) = volume_complaint(&out, expected, merged, &here) {
                            torn.push(c);
                        }
                    }
                }
            }
        }
    }
    assert!(
        torn.is_empty(),
        "{} of 9464 corner-overlap unions tore; first few:\n{}",
        torn.len(),
        torn.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
    );
}

/// The mutual weld does NOT always reach a fixed point, so `MAX_WELD_PASSES`
/// is a terminator and not merely a safety margin.
///
/// Review round 3 asked for the cap to be removed in favour of "iterate until
/// a pass reports `moved == 0`". That would hang. Re-running
/// `promote_operands_mutually` UNCAPPED over 80,000 randomised near-coplanar
/// box pairs (arbitrary rotation axis, angle in ±90°, edges 0.3–3.0, Z offsets
/// −6..+6 snap steps) left 40 of them moving the SAME vertex count on every
/// one of 64 passes and still going — the oscillation the cap exists to bound,
/// a vertex alternating between two planes equidistant within the band. A
/// further 8 converged, but only after 5 to 13 moving passes. The pinned
/// corner-overlap sweep above never exceeds two, which is why the cap looked
/// unreachable when it was written; that measurement was true of that sweep
/// and not of the operand space.
///
/// The pair below is the first non-convergent case that hunt found (seed
/// 0x5DEECE66D). It is pinned as a REGRESSION GUARD ON THE CAP: with the cap
/// this test finishes in milliseconds, and any change that iterates to a fixed
/// point instead hangs here rather than in a user's model.
#[test]
fn the_weld_pass_cap_is_load_bearing_because_the_weld_can_oscillate() {
    let a = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    let bmin = [-0.121564, -0.506766, 0.5224210351562499];
    let sz = [1.4774241000000001, 2.6912361, 1.6436199];
    let axis = Vector3::new(0.321974, 0.47062000000000004, 0.603912);
    let about = [
        bmin[0] + sz[0] / 2.0,
        bmin[1] + sz[1] / 2.0,
        bmin[2] + sz[2] / 2.0,
    ];
    let b = boxed(bmin, sz, Some((axis, -0.8068835155553489, about)));
    assert_eq!(open_edges(&a), Ok(0), "operand A must be closed going in");
    assert_eq!(open_edges(&b), Ok(0), "operand B must be closed going in");
    let clipper = ClippingProcessor::new();
    // Both orders, and the assertion is that each RETURNS at all: an uncapped
    // weld never gets here.
    for (order, out) in [
        ("A then B", clipper.union_mesh(&a, &b)),
        ("B then A", clipper.union_mesh(&b, &a)),
    ] {
        let out = out.expect("union must not error");
        assert!(
            !out.is_empty(),
            "the capped weld must still produce a union ({order})"
        );
    }
}
