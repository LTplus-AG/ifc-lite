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

fn accepted(text: &str) -> Result<(), String> {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text, &mut decoder);
    let product = decoder.decode_by_id(72245).unwrap();
    let traversal = Traversal::new(1,1);
    let mut program = traversal.product_parts(&product);
    while let Some(ticket) = program.request().map_err(|e|format!("{e:?}"))? {
        let (reply, _, _storage) = program.admit(ticket,&router,&mut decoder).map_err(|e|format!("{e:?}"))?;
        program.accept(reply,&router).map_err(|e|format!("{:?}",e.error))?;
    }
    program.finish().map(|_|()).map_err(|e|format!("{e:?}"))
}
#[test]
fn issue_3641_near_collinear_retrace_must_remain_unsupported() {
    let near = FIXTURE.replace("((0.,0.),(870.,0.),(1400.","((0.,0.000000000001),(870.,0.),(1400.");
    assert!(accepted(&near).is_err(), "nonzero winding sliver must never be cancelled by a tolerance");
}
#[test]
fn issue_3641_self_crossing_residual_must_remain_unsupported() {
    let crossed = FIXTURE.replace("((0.,0.),(870.,0.),(1400.,-900.),(4500.,-900.00001),(4500.,0.))", "((0.,0.),(-2.,0.),(0.,0.),(4.,4.),(0.,4.),(3.,0.))")
        .replace("IFCLINEINDEX((1,2,3,4,5,1))", "IFCLINEINDEX((1,2,3,4,5,6,1))");
    assert!(accepted(&crossed).is_err(), "cancelling a spur cannot certify a self-crossing region");
}
