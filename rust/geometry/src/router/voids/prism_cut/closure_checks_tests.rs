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
/// welding: the predicates quantize to a 0.1 mm grid themselves, so coincident
/// vertices spelled as separate entries are the same point to them (which is
/// exactly the production situation — the kernel's output is flat-shaded).
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
/// multiplicity sweep sees it.
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

/// Degenerate triangles (all three corners on one grid cell) are skipped by the
/// signed predicates; the multiplicity sweep must skip them identically, or a
/// mesh the closure audit calls clean would be rejected here for edges that
/// audit never counted.
#[test]
fn degenerate_triangles_are_skipped_exactly_as_the_signed_predicates_skip_them() {
    let mut m = tetrahedron();
    // A sliver whose three corners quantize to the same 0.1 mm cell, sharing
    // two of its vertices with a real edge of the solid.
    let base = (m.positions.len() / 3) as u32;
    for p in [[0.0, 0.0, 0.0], [1.0e-6, 0.0, 0.0], [0.0, 1.0e-6, 0.0]] {
        m.positions.push(p[0]);
        m.positions.push(p[1]);
        m.positions.push(p[2]);
        m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
    }
    m.indices
        .extend_from_slice(&[base, base + 1, base + 2]);

    assert!(directed_closed(&m), "the signed audit skips the degenerate");
    assert!(
        edge_multiplicity_defects(&m).is_clean(),
        "the multiplicity sweep must skip the same degenerate"
    );
}
