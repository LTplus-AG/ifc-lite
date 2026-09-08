// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`]'s mesh-topology predicates. Split into a
//! `*_tests.rs` file (module-size-ratchet exempt) and attached via `#[path]`,
//! the shape `csg_tests.rs` / `prism_cut_tests.rs` already use.
//!
//! Each test below pairs the new multiplicity reading with the OLD signed
//! predicates on the SAME mesh. That pairing is the point: a test that only
//! asserted `over_used == 1` would still pass if `directed_closed` had been
//! quietly strengthened to catch the same thing, and the reader could not tell
//! which predicate was load-bearing. Asserting that the signed tally says
//! "closed" on a mesh the multiplicity sweep rejects pins the gap this module
//! exists to close.

use super::{closed_or_hairline, directed_closed, edge_multiplicity_defects};
use crate::mesh::Mesh;

/// Build a mesh from raw vertex positions and triangle indices. Flat list, no
/// welding: `edge_multiplicity_defects` keys on the coordinates themselves, so
/// a vertex spelled twice with identical numbers is one point to it (which is
/// the production situation — the kernel's output is flat-shaded, and its
/// interner makes a shared corner bit-identical at every use).
fn mesh_of(positions: &[[f64; 3]], tris: &[[u32; 3]]) -> Mesh {
    let mut mesh = Mesh::new();
    for p in positions {
        mesh.positions.push(p[0] as f32);
        mesh.positions.push(p[1] as f32);
        mesh.positions.push(p[2] as f32);
        mesh.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
    }
    for t in tris {
        mesh.indices.extend_from_slice(t);
    }
    mesh
}

/// A closed, correctly wound unit tetrahedron: the control. Every predicate
/// must accept it, so a later failure elsewhere cannot be blamed on the
/// fixture builder.
fn tetrahedron() -> Mesh {
    mesh_of(
        &[
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        &[[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
    )
}

/// A closed, correctly wound square bipyramid (octahedron) whose equator sits
/// at `z_base`, so two of them can be stacked a chosen distance apart.
fn bipyramid(z_base: f64) -> Mesh {
    let z = z_base;
    mesh_of(
        &[
            [1.0, 0.0, z],
            [0.0, 1.0, z],
            [-1.0, 0.0, z],
            [0.0, -1.0, z],
            [0.0, 0.0, z + 1.0],
            [0.0, 0.0, z - 1.0],
        ],
        &[
            [0, 1, 4],
            [1, 2, 4],
            [2, 3, 4],
            [3, 0, 4],
            [1, 0, 5],
            [2, 1, 5],
            [3, 2, 5],
            [0, 3, 5],
        ],
    )
}

/// A closed, correctly wound unit-square slab of thickness `t`.
fn slab(t: f64) -> Mesh {
    mesh_of(
        &[
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, t],
            [1.0, 0.0, t],
            [1.0, 1.0, t],
            [0.0, 1.0, t],
        ],
        &[
            [0, 2, 1],
            [0, 3, 2], // bottom
            [4, 5, 6],
            [4, 6, 7], // top
            [0, 1, 5],
            [0, 5, 4], // -Y
            [1, 2, 6],
            [1, 6, 5], // +X
            [2, 3, 7],
            [2, 7, 6], // +Y
            [3, 0, 4],
            [3, 4, 7], // -X
        ],
    )
}

#[test]
fn a_closed_tetrahedron_has_no_multiplicity_defect() {
    let m = tetrahedron();
    assert!(directed_closed(&m), "control fixture must be directed-closed");
    assert_eq!(
        edge_multiplicity_defects(&m),
        super::EdgeMultiplicityDefects::default(),
        "a closed, consistently wound solid must carry no multiplicity defect"
    );
}

/// THREE triangles on one shared edge: the fin. The signed tally nets to zero
/// on that edge (two uses one way, one the other, plus the fin's own boundary
/// is what actually fails there), so the interesting assertion is the doubled
/// case below; this one pins the count itself.
#[test]
fn an_edge_used_by_three_triangles_is_over_used() {
    let m = mesh_of(
        &[
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        &[[0, 1, 2], [1, 0, 3], [0, 1, 4]],
    );
    let d = edge_multiplicity_defects(&m);
    assert_eq!(d.over_used, 1, "edge 0-1 is used by three triangles");
    assert_eq!(d.same_direction, 0);
}

/// The case that motivates the whole predicate: a DOUBLED coincident surface.
/// Every edge is used four times, two each way, so the signed tally cancels
/// exactly and BOTH existing predicates call this closed. Only the unsigned
/// multiplicity sweep sees it. The two shells are bit-identical here, which is
/// what makes them one surface twice rather than two surfaces near each other
/// — see `two_solids_a_hair_apart_are_not_one_non_manifold_solid` below for
/// the case this must NOT be confused with.
///
/// If this test ever goes green on the `directed_closed` assertion below, the
/// signed predicate changed meaning and this module's justification needs
/// re-reading — that is deliberate, not an over-tight assertion.
#[test]
fn a_doubled_coincident_shell_reads_as_closed_to_the_signed_tally() {
    let mut m = tetrahedron();
    let dup = m.clone();
    m.merge(&dup);

    assert!(
        directed_closed(&m),
        "the signed tally cancels a doubled shell to zero — this is the blind spot"
    );
    assert!(
        closed_or_hairline(&m),
        "the hairline predicate inherits the same signed cancellation"
    );

    let d = edge_multiplicity_defects(&m);
    assert_eq!(
        d.over_used, 6,
        "all six tetrahedron edges are used four times by the doubled shell"
    );
    assert_eq!(d.same_direction, 0);
}

/// Two triangles sharing an edge in the SAME direction: one of them is wound
/// backwards. Distinct from `over_used` (only two uses), and distinct from an
/// open edge (two uses, not one).
#[test]
fn two_same_direction_uses_of_one_edge_are_a_winding_defect() {
    let m = mesh_of(
        &[
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0],
        ],
        // Both triangles traverse 0 -> 1; a consistent pair would run 1 -> 0
        // in the second.
        &[[0, 1, 2], [0, 1, 3]],
    );
    let d = edge_multiplicity_defects(&m);
    assert_eq!(d.same_direction, 1, "edge 0-1 is traversed twice the same way");
    assert_eq!(d.over_used, 0);
}

/// An OPEN shell is deliberately NOT a multiplicity defect. This is the
/// separation the gate depends on: T-junction tessellation produces
/// singly-used edges constantly, and a predicate that flagged them would
/// inherit that false-positive rate. The open reading stays with
/// `directed_closed` / `closed_or_hairline`.
#[test]
fn an_open_boundary_is_not_a_multiplicity_defect() {
    let m = mesh_of(
        &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        &[[0, 1, 2]],
    );
    assert!(!directed_closed(&m), "a lone triangle is open");
    assert!(
        edge_multiplicity_defects(&m).is_clean(),
        "singly-used edges are the OPEN reading, not the multiplicity reading"
    );
}

/// A triangle with two corners at the SAME point bounds nothing; its uses must
/// not be counted. (Its neighbours here are the tetrahedron's, so if the skip
/// were missing they would show up as extra uses on a real edge.)
#[test]
fn a_triangle_with_two_coincident_corners_is_skipped() {
    let mut m = tetrahedron();
    let base = (m.positions.len() / 3) as u32;
    for p in [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0]] {
        m.positions.push(p[0]);
        m.positions.push(p[1]);
        m.positions.push(p[2]);
        m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
    }
    m.indices.extend_from_slice(&[base, base + 1, base + 2]);

    assert!(
        edge_multiplicity_defects(&m).is_clean(),
        "a zero-area triangle must contribute no edge uses"
    );
}

/// The regression this predicate's EXACT keying exists for. Two closed,
/// perfectly manifold bipyramids sitting 0.03 mm apart — closer than the
/// 0.1 mm cell the sibling predicates snap to. Under a snapped key their
/// vertices collide, their edges fuse, and the fused entries report four uses
/// apiece: `over_used = 12` (measured by re-instating the snapped key), every
/// one of it invented. Under exact keys they are what they are, two separate
/// solids.
///
/// 0.03 mm is not arbitrary: it has to be under the sibling predicates' cell
/// so the assertion below distinguishes the two keyings rather than agreeing
/// with both.
#[test]
fn two_solids_a_hair_apart_are_not_one_non_manifold_solid() {
    let mut m = bipyramid(0.0);
    let offset = bipyramid(0.000_03);
    m.merge(&offset);

    let d = edge_multiplicity_defects(&m);
    assert!(
        d.is_clean(),
        "two manifold solids 0.03 mm apart are still two manifold solids, got {d:?}"
    );
}

/// The same failure in the other geometry that trips it: a single slab thinner
/// than the sibling predicates' cell. Snap it and the two faces land on one
/// plane, the diagonal is used by four triangles (`over_used = 1`, measured the
/// same way), and a perfectly good thin layer reads as non-manifold. Real
/// models are full of these — a finish layer, a gasket, a sheet-metal fold.
#[test]
fn a_slab_thinner_than_the_snap_cell_carries_no_defect() {
    let m = slab(0.000_05);
    let d = edge_multiplicity_defects(&m);
    assert!(
        d.is_clean(),
        "a 0.05 mm-thick closed slab is manifold, got {d:?}"
    );
}
