/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


use crate::facet_weld::facet_weld_scoped_tests::{slivered_box, whole_mesh_box};
use crate::facet_weld::refine_high_aspect_slivers_within;

#[test]
fn a_cut_without_slivers_keeps_its_vertices_and_indices() {
    let mesh = slivered_box(1, 1.0);
    let region = [whole_mesh_box(&mesh)];
    let output = refine_high_aspect_slivers_within(&mesh, &region);
    assert_eq!(output.positions, mesh.positions);
    assert_eq!(output.indices, mesh.indices);
}
