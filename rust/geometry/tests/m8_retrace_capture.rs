// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{document::RetainedRecipe, program::transactions::{Traversal, OperationKind}, GeometryRouter};
const FIXTURE: &str = include_str!("../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");

#[test]
fn issue_3641_retained_product_walk_has_one_four_edge_construction() {
    let source = SourceBundle::new(FIXTURE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(FIXTURE, &mut decoder);
    let product = decoder.decode_by_id(72245).unwrap();
    let traversal = Traversal::new(1, 1);
    let mut program = traversal.product_parts(&product);
    let mut constructions = 0;
    while let Some(ticket) = program.request().unwrap() {
        let (reply, operations, _storage) = program.admit(ticket, &router, &mut decoder).unwrap();
        for op in operations {
            if let OperationKind::Construction(RetainedRecipe::Extrusion(extrusion)) = op.kind() {
                constructions += 1;
                assert_eq!(extrusion.source.profile.as_ref().unwrap().loops[0].segments.len(), 4);
            } else { panic!("unexpected non-extrusion operation"); }
        }
        program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(constructions, 1);
    assert_eq!(program.finish().unwrap().values().len(), 1);
}
