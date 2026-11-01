// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #8291: which face sets a runtime may be asked to stitch, decided from source facts.
use ifc_lite_geometry::document::RetainedFaceSet;

fn set(triangles: Vec<u32>) -> RetainedFaceSet {
    let rows = (0..triangles.len() as u32 / 3).collect();
    RetainedFaceSet {
        source_id: 1,
        positions: vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.],
        row_count: triangles.len() as u32 / 3,
        triangles,
        rows,
        source_corners: Vec::new(),
        source_slots: Vec::new(),
        length_unit_scale: 1.,
    }
}

#[test]
fn issue_8291_a_closed_tetrahedron_admits_a_solid() {
    assert!(set(vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]).admits_solid());
}

#[test]
fn issue_8291_a_shell_with_boundary_edges_never_reaches_a_worker() {
    assert!(!set(vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 2, 3]).admits_solid(), "closed, but one face wound against the rest");
    assert!(!set(vec![0, 2, 1, 0, 1, 3, 1, 2, 3]).admits_solid(), "a missing face");
}
