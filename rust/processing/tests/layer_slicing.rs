// SPDX-License-Identifier: MPL-2.0
use ifc_lite_processing::{process, ProcessingRequest};

#[test]
fn issue_7782_d66_layer_slicing_is_opt_in() {
    let content = include_bytes!("fixtures/c4_native_unsliced_layers_7782.ifc");
    let default = process(content, &ProcessingRequest::full_pass(), &mut ());
    let off = process(content, &ProcessingRequest::full_pass().layer_slicing(false), &mut ());
    assert_eq!(
        serde_json::to_value(&default.meshes).unwrap(),
        serde_json::to_value(&off.meshes).unwrap()
    );
    let wall: Vec<_> = default.meshes.iter().filter(|m| m.express_id == 100).collect();
    assert_eq!(wall.len(), 1);
    assert_eq!(wall[0].indices.len() / 3, 12);
    let on = process(content, &ProcessingRequest::full_pass().layer_slicing(true), &mut ());
    let wall: Vec<_> = on.meshes.iter().filter(|m| m.express_id == 100).collect();
    // The same fixture's browser C4-0 observation has three material layers.
    assert_eq!(wall.len(), 3);
    let mut triangles: Vec<_> = wall.iter().map(|m| m.indices.len() / 3).collect();
    triangles.sort_unstable();
    assert_eq!(triangles, [14, 18, 20]);
}
