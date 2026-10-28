// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M4: source admission and logical operations, never fake kernel receipts.
use ifc_lite_core::{EntityDecoder, SourceBundle};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex, BoolOp,
    program::transactions::{LayerAdmission, LayerSpec, Traversal, Program, Plan, OperationKind, Requirement}};
use std::sync::Arc;
const CURVED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
const STRAIGHT: &str = include_str!("../../../tests/fixtures/cli-retained/layered-wall.ifc");
fn with(text: &str, id: u32, run: impl FnOnce(LayerSpec, &Traversal, &GeometryRouter, &mut EntityDecoder)) {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(text, &mut decoder);
    router.set_material_layer_index(Arc::new(MaterialLayerIndex::from_content(text, &mut decoder)));
    let entity = decoder.decode_by_id(id).unwrap();
    let LayerAdmission::Bands(spec) = Traversal::layer_admission(&entity,&router,&mut decoder).unwrap() else { panic!("bands required"); };
    run(spec,&Traversal::new(1,1),&router,&mut decoder);
}
fn body(mut program: Program<'_>, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Plan {
    while let Some(ticket) = program.request().unwrap() {
        let (reply,operations,_storage) = program.admit(ticket,router,decoder).unwrap();
        for op in operations { op.bind_numerical_outcome(false).unwrap(); }
        program.accept(reply,router).unwrap_or_else(|e| panic!("{:?}",e.error));
    }
    program.finish().unwrap()
}
fn signs(sigma: f64, sense: f64, expected: [f64;2], outside_first: bool) {
    let mut text = CURVED.to_owned();
    if sigma < 0. { text = text.replace("#28=IFCTRIMMEDCURVE(#27,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267949)),.T.,.PARAMETER.);",
        "#28=IFCTRIMMEDCURVE(#27,(IFCPARAMETERVALUE(1.5707963267949)),(IFCPARAMETERVALUE(0.)),.F.,.PARAMETER.);"); }
    if sense > 0. { text = text.replace(".AXIS2.,.NEGATIVE.,0.,$)",".AXIS2.,.POSITIVE.,0.,$)"); }
    with(&text,55,|spec,traversal,router,decoder| {
        assert_eq!(spec.source_id,23);
        assert_eq!(spec.layers,[(16,0.1),(18,0.2),(20,0.3)]);
        for (c,r) in spec.cumulative().into_iter().zip(expected) { assert!((spec.radius_at(c).unwrap()-r).abs()<1e-12); }
        let entity = decoder.decode_by_id(55).unwrap();
        let host = body(traversal.product_parts(&entity),router,decoder);
        let mut program = traversal.layer_bands(host,spec).unwrap();
        let ticket = program.request().unwrap().unwrap();
        let (_,operations,_storage) = program.admit(ticket,router,decoder).unwrap();
        let OperationKind::Construction(ifc_lite_geometry::document::RetainedRecipe::Prism(first)) = operations[0].kind() else { panic!("prism"); };
        assert_eq!(first.loops.len(),if outside_first {2} else {1});
        let boundary = if outside_first { &first.loops[1] } else { &first.loops[0] };
        let ifc_lite_geometry::document::PrismSegment::Circle { radius,.. } = boundary.segments[0] else { panic!("circle"); };
        assert!((radius-expected[0]).abs()<1e-12);
    });
}
// IFC positive Axis2 follows the left normal. On a CCW arc it points inward;
// CW outward. Solve sigma*(10-rho)=offset+sense*C, with offset=0 and C=.1,.3.
#[test] fn m4_ccw_positive_inward() { signs(1.,1.,[9.9,9.7],true); } // 10-rho=+.1 => rho=9.9; first rho>9.9.
#[test] fn m4_ccw_negative_outward() { signs(1.,-1.,[10.1,10.3],false); } // 10-rho=-.1 => rho=10.1; first rho<10.1.
#[test] fn m4_cw_positive_outward() { signs(-1.,1.,[10.1,10.3],false); } // rho-10=+.1 => rho=10.1; first rho<10.1.
#[test] fn m4_cw_negative_inward() { signs(-1.,-1.,[9.9,9.7],true); } // rho-10=-.1 => rho=9.9; first rho>9.9.

#[test]
fn m4_two_admissions_each_band_uses_the_same_opened_host() {
    with(STRAIGHT,27,|spec,traversal,router,decoder| {
        let entity = decoder.decode_by_id(27).unwrap();
        let host = body(traversal.product_parts(&entity),router,decoder).discharge_unvoided();
        let original = host.values().next().unwrap().slot();
        let frame = *host.values().next().unwrap().object_frame();
        let mut program = traversal.layer_bands(host,spec).unwrap();
        for phase in 0..2 {
            let ticket = program.request().unwrap().unwrap();
            let (reply,operations,_storage) = program.admit(ticket,router,decoder).unwrap();
            assert_eq!(operations.len(),2);
            for op in operations {
                if phase == 0 { assert!(matches!(op.kind(),OperationKind::Construction(_))); }
                else {
                    let OperationKind::Boolean { inputs,operation } = op.kind() else { panic!("intersection"); };
                    assert_eq!(operation,BoolOp::Intersection);
                    assert_eq!(inputs[0].slot(),original);
                    assert_eq!(*op.value().object_frame(),frame);
                }
                op.bind_numerical_outcome(false).unwrap();
            }
            program.accept(reply,router).unwrap_or_else(|e| panic!("{:?}",e.error));
        }
        assert!(program.request().unwrap().is_none());
        let result = program.finish().unwrap();
        assert_eq!(result.layers().unwrap().tags.len(),2);
        assert!(!result.requirements().any(|r| matches!(r,Requirement::MaterialLayers|Requirement::OpeningClosure)));
    });
}

#[test]
fn m4_certified_empty_bands_drop_or_restore_unsliced_host() {
    for empty in [[false,true],[true,false],[true,true]] {
        with(STRAIGHT,27,|spec,traversal,router,decoder| {
            let entity = decoder.decode_by_id(27).unwrap();
            let host = body(traversal.product_parts(&entity),router,decoder);
            let original = host.values().next().unwrap().slot();
            let mut program = traversal.layer_bands(host,spec).unwrap();
            for phase in 0..2 {
                let ticket = program.request().unwrap().unwrap();
                let (reply,operations,_storage) = program.admit(ticket,router,decoder).unwrap();
                for (i,op) in operations.into_iter().enumerate() { op.bind_numerical_outcome(phase==1 && empty[i]).unwrap(); }
                program.accept(reply,router).unwrap_or_else(|e| panic!("{:?}",e.error));
            }
            if empty == [true,true] { assert_eq!(program.finish().err().unwrap().kind(),ifc_lite_geometry::program::transactions::TransactionFailureKind::EmptyResult); }
            else {
                let result = program.finish().unwrap();
                assert_eq!(result.values().next().unwrap().slot(),original);
                assert!(result.layers().is_none());
                assert!(!result.requirements().any(|r| r==Requirement::MaterialLayers));
            }
        });
    }
}
