// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
#[path = "../../geometry/tests/support/cut0_prisms.rs"]
mod fixture;
use ifc_lite_geometry::document::GeometryDocument;
use ifc_lite_geometry_runtime::{SmlibWorker, MeshLimits};
// #7955: real adapter witnesses; a missing SDK never emits an executed marker.
#[test]
fn cut0_prism_box_and_arc_construction() {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib required");
        eprintln!("SKIP cut0 prisms: set IFCLITE_SMLIB_WORKER"); return;
    };
    let mut worker = SmlibWorker::spawn(path).unwrap();
    worker.qualify_ordered_regions().unwrap();
    for arc in [false,true] {
        let mut document=GeometryDocument::new();
        let definition=document.add_retained_prism(fixture::prism(arc)).unwrap();
        let request=document.prepare_retained(definition,worker.incarnation()).unwrap();
        let result=worker.evaluate_retained(request,0.00001,1.,MeshLimits::default()).unwrap();
        fixture::verify(&result.completion().tessellation,arc);
        println!("sdk witness executed: {}",if arc { "cut0_prism_arc" } else { "cut0_prism_box" });
    }
}
