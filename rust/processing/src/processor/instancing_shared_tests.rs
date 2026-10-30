// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! EDGE-WASM-18 (#8341): the grouping and template selection the native
//! finalize and the browser batch both call.

use super::*;
use ifc_lite_geometry::InstanceMeta;

fn occurrence(express_id: u32, rep_identity: u128) -> RawInstanceOccurrence {
    RawInstanceOccurrence {
        express_id,
        ifc_type: "IfcFlowFitting".to_string(),
        global_id: None,
        name: None,
        presentation_layer: None,
        color: [1.0; 4],
        rep_identity,
        world_transform: [0.0; 16],
        geometry_item_id: None,
    }
}

fn mesh(express_id: u32, positions: Vec<f32>, rep_identity: u128, instanceable: bool) -> MeshData {
    MeshData::new(express_id, "IfcWall".to_string(), positions, Vec::new(), Vec::new(), [1.0; 4])
        .with_instance(Some(InstanceMeta {
            transform: [0.0; 16],
            local_transform: None,
            canonical_transform: None,
            rep_identity,
            instanceable,
        }))
}

/// Groups ascend by rep regardless of arrival order, and each group keeps
/// its occurrences in arrival order (not sorted by express id).
#[test]
fn groups_ascend_by_rep_and_keep_arrival_order_within() {
    const WIDE: u128 = 1 << 70;
    let raw = vec![
        occurrence(9, 30),
        occurrence(5, 10),
        occurrence(4, WIDE),
        occurrence(1, 30),
        occurrence(7, 10),
        occurrence(3, 2),
    ];
    let groups: Vec<(u128, Vec<u32>)> = group_occurrences_by_rep(raw)
        .into_iter()
        .map(|(rep, occs)| (rep, occs.iter().map(|o| o.express_id).collect()))
        .collect();
    assert_eq!(groups, vec![(2, vec![3]), (10, vec![5, 7]), (30, vec![9, 1]), (WIDE, vec![4])]);
}

/// The template is the FIRST non-empty, instanceable mesh per rep: an empty
/// mesh and an un-instanceable one ahead of it are skipped, and a later
/// candidate for the same rep never displaces it. `info` sees positions in
/// the iterated sequence.
#[test]
fn the_first_non_empty_instanceable_mesh_is_the_template() {
    let meshes = vec![
        mesh(1, Vec::new(), 10, true),
        mesh(2, vec![0.0; 3], 10, false),
        mesh(3, vec![0.0; 3], 10, true),
        mesh(4, vec![0.0; 3], 10, true),
        mesh(5, vec![0.0; 3], 20, true),
    ];
    let picked = index_templates_by_rep(meshes.iter(), |i, m| (i, m.express_id));
    assert_eq!(picked.len(), 2);
    assert_eq!(picked[&10], (2, 3));
    assert_eq!(picked[&20], (4, 5));
    assert!(index_templates_by_rep(&meshes[..2], |i, _| i).is_empty());
}
