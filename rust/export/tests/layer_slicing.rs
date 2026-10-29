// SPDX-License-Identifier: MPL-2.0
use ifc_lite_export::{export_obj_with_stats, try_export_glb_with_stats, GltfOptions, ObjOptions};

#[test]
fn issue_7782_d66_export_options_reach_native_slicing() {
    let content = include_bytes!("../../processing/tests/fixtures/c4_native_unsliced_layers_7782.ifc");
    for (slicing, expected) in [(false, 12), (true, 52)] {
        let (_, glb) = try_export_glb_with_stats(content, &GltfOptions::default().with_layer_slicing(slicing)).unwrap();
        let (_, obj) = export_obj_with_stats(content, &ObjOptions { layer_slicing: slicing, ..ObjOptions::default() }).unwrap();
        assert_eq!(glb.triangles, expected);
        assert_eq!(obj.triangles, expected);
    }
}
