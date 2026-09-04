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

/// A unit box at the origin, and a unit box rotated 30 degrees about Z placed
/// so it overlaps the first one's `+X+Y` corner, with `z_offset` added to the
/// rotated box's Z span.
fn corner_overlap_pair(z_offset: f64, b_height: f64) -> (Mesh, Mesh) {
    let a = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    let b_min = [0.5, 0.5, z_offset];
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
    let (a, b) = corner_overlap_pair(z_offset, b_height);
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
                    let a = boxed([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
                    let b_min = [dx, dy, b_z + dz];
                    let about = [b_min[0] + 0.5, b_min[1] + 0.5, b_min[2] + b_h / 2.0];
                    let b = boxed(
                        b_min,
                        [1.0, 1.0, b_h],
                        Some((Vector3::z(), 30.0f64.to_radians(), about)),
                    );
                    // BOTH orders: `a ∪ b` and `b ∪ a` are the same solid, and
                    // on `main` the two orders tore 2090 and 2388 times here.
                    for (order, out) in [
                        ("A then B", clipper.union_mesh(&a, &b)),
                        ("B then A", clipper.union_mesh(&b, &a)),
                    ] {
                        let out = out.expect("union must not error");
                        if let other @ (Ok(1..) | Err(_)) = open_edges(&out) {
                            torn.push(format!(
                                "steps={steps} b_z={b_z} b_h={b_h} dx={dx} dy={dy} \
                                 {order}: {other:?}"
                            ));
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
