// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{document::RetainedRecipe, program::transactions::{
    Traversal, Operation, OperationKind, TransactionError, TransactionFailureKind,
}, GeometryRouter};
#[path = "support/m5_clips.rs"]
mod fixture;

// #7955: logical annotations exercise the controller; they are not SDK evidence.
fn drive(text: &str, empty_boolean: Option<usize>) -> (Vec<Operation>, Result<(), TransactionError>) {
    drive_product(text,13,empty_boolean)
}
fn drive_product(text:&str,id:u32,empty_boolean:Option<usize>)->(Vec<Operation>,Result<(),TransactionError>){
    let source = SourceBundle::new(text.as_bytes().to_vec()); let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text, &mut decoder);
    let wall = decoder.decode_by_id(id).unwrap(); let traversal = Traversal::new(1, 1);
    let mut program = traversal.product_parts(&wall); let mut operations:Vec<Operation> = Vec::new(); let mut booleans = 0;
    let result = loop {
        let ticket = match program.request() {
            Ok(Some(t)) => t, Err(e) => break Err(e),
            Ok(None) => break program.finish().map(|p| {
                assert_eq!(p.values().len(),1);
                assert_eq!(p.values()[0].slot(),operations.last().unwrap().value().slot());
            }),
        };
        let (reply, batch, _) = match program.admit(ticket, &router, &mut decoder) {
            Ok(r) => r, Err(e) => break Err(e),
        };
        for op in batch {
            let boolean = matches!(op.kind(), OperationKind::Boolean { .. });
            if boolean { booleans += 1; }
            op.bind_numerical_outcome(boolean && empty_boolean == Some(booleans)).unwrap();
            operations.push(op);
        }
        if let Err(e) = program.accept(reply, &router) { break Err(e.error); }
    };
    (operations, result)
}
fn prism(ops: &[Operation]) -> &ifc_lite_geometry::document::RetainedPrism {
    ops.iter().find_map(|op| match op.kind() {
        OperationKind::Construction(RetainedRecipe::Prism(p)) => Some(p), _ => None,
    }).expect("clip must issue a finite cutter")
}
#[test]
fn issue_7955_agreement_flag_selects_opposite_removed_sides() {
    let (yes, result) = drive(fixture::SOURCE, None); result.unwrap();
    let (no, result) = drive(&fixture::SOURCE.replace("#8,.T.", "#8,.F."), None); result.unwrap();
    assert_eq!(&prism(&yes).frame[8..11], &[0.,0.,-1.]);
    assert_eq!(&prism(&no).frame[8..11], &[0.,0.,1.]);
    for ops in [&yes,&no] {
        assert_eq!(ops.len(),3);
        assert!(matches!(ops[2].kind(), OperationKind::Boolean { operation: ifc_lite_geometry::BoolOp::Difference, .. }));
        assert_eq!(ops[0].value().evaluation_bounds(), ops[2].value().evaluation_bounds());
    }
}
#[test]
fn issue_7955_three_chain_issues_ordered_cutter_differences() {
    let (ops, result) = drive(&fixture::chain(), None); result.unwrap();
    assert_eq!(ops.len(),7);
    for (i, id) in [24,29,34].into_iter().enumerate() {
        let cutter = &ops[1+2*i];
        assert!(matches!(cutter.kind(), OperationKind::Construction(RetainedRecipe::Prism(p)) if p.source_id == id));
        let OperationKind::Boolean { inputs, .. } = ops[2+2*i].kind() else { panic!("expected Difference") };
        assert_eq!(inputs[0].slot(),ops[2*i].value().slot());
        assert_eq!(inputs[1].slot(),cutter.value().slot());
    }
}
#[test]
fn issue_7955_kept_side_skip_issues_only_host_and_preserves_slot() {
    let text=fixture::SOURCE.replace("(0.,0.,0.5)","(0.,0.,-1.)");
    let (ops,result)=drive(&text,None);result.unwrap();assert_eq!(ops.len(),1);
}
#[test]
fn issue_7955_consumed_clip_attributes_halfspace_before_decoding_next_operand() {
    for text in [fixture::SOURCE.to_string(), fixture::SOURCE.replace("'CSG',(#10)","'CSG',(#50)")
        .replace("ENDSEC;END-ISO","#50=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#999999);ENDSEC;END-ISO")] {
        let (ops,result)=drive(&text,Some(1));
        assert_eq!(ops.len(),3);
        let error=result.unwrap_err();assert_eq!(error.kind(),TransactionFailureKind::EmptyResult);
        assert_eq!(error.origin_view(),Some(("halfspace_clip",Some(9),"consumed")));
    }
}
#[test]
fn issue_7955_union_intersection_and_invalid_surface_refuse_before_cutter() {
    for (text,kind) in [
        (fixture::SOURCE.replace(".DIFFERENCE.",".UNION."),TransactionFailureKind::OperationUnsupported),
        (fixture::SOURCE.replace(".DIFFERENCE.",".INTERSECTION."),TransactionFailureKind::OperationUnsupported),
        (fixture::SOURCE.replace("IFCPLANE(#7)","IFCSPHERICALSURFACE(#7,1.)"),TransactionFailureKind::Source),
        (fixture::SOURCE.replace("IFCPLANE(#7)","IFCPLANE(#999999)"),TransactionFailureKind::Source),
    ] {
        let (ops,result)=drive(&text,None);assert_eq!(ops.len(),1);
        let error=result.unwrap_err();assert_eq!(error.kind(),kind);
        let (site,id,_)=error.origin_view().unwrap();assert_eq!((site,id),("boolean_second_operand",Some(9)));
    }
}
#[test]
fn issue_7955_mapped_nonuniform_host_bakes_before_cutter() {
    // Explicitly non-schema extension: IfcMappedItem is not IfcBooleanOperand.
    let text=include_str!("../../../tests/fixtures/synthetic-retained/m5-adversarial-nonschema-mapped-operand.ifc");
    let (ops,result)=drive_product(text,27,None);result.unwrap();assert_eq!(ops.len(),4);
    assert!(matches!(ops[1].kind(),OperationKind::Affine { .. }));
    assert!(matches!(ops[2].kind(),OperationKind::Construction(RetainedRecipe::Prism(_))));
    assert_eq!(ops[1].value().evaluation_bounds(),ops[3].value().evaluation_bounds());
}
