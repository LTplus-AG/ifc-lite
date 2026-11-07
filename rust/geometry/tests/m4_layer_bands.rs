// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M4: source admission and logical operations, never fake kernel receipts.
use ifc_lite_core::{EntityDecoder, SourceBundle};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex, BoolOp,
    program::transactions::{LayerAdmission, LayerSpec, LayerUsages, Traversal, Program, Plan, OperationKind, Requirement}};
use std::sync::Arc;
const CURVED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
const STRAIGHT: &str = include_str!("../../../tests/fixtures/cli-retained/layered-wall.ifc");
fn with(text: &str, id: u32, run: impl FnOnce(LayerSpec, &Traversal, &GeometryRouter, &mut EntityDecoder)) {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(text, &mut decoder);
    router.set_material_layer_index(Arc::new(MaterialLayerIndex::from_content(text, &mut decoder)));
    let usages = LayerUsages::from_content(text.as_bytes(), &mut decoder);
    let entity = decoder.decode_by_id(id).unwrap();
    let LayerAdmission::Bands(spec) = Traversal::layer_admission(&entity,&router,&usages,&mut decoder).unwrap() else { panic!("bands required"); };
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
fn signs(sigma: f64, sense: f64, offset: f64, expected: [f64;2], outside_first: bool) {
    let mut text = CURVED.to_owned();
    if sigma < 0. { text = text.replace("#28=IFCTRIMMEDCURVE(#27,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267949)),.T.,.PARAMETER.);",
        "#28=IFCTRIMMEDCURVE(#27,(IFCPARAMETERVALUE(1.5707963267949)),(IFCPARAMETERVALUE(0.)),.F.,.PARAMETER.);"); }
    let direction=if sense>0. {"POSITIVE"} else {"NEGATIVE"};
    text = text.replace(".AXIS2.,.NEGATIVE.,0.,$)",&format!(".AXIS2.,.{direction}.,{offset},$)"));
    with(&text,55,|spec,traversal,router,decoder| {
        assert_eq!(spec.source_id,23);
        assert_eq!(spec.layers,[(16,0.1),(18,0.2),(20,0.3)]);
        for (c,r) in spec.cumulative().zip(expected) { assert!((spec.radius_at(c).unwrap()-r).abs()<1e-12); }
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
#[test] fn m4_ccw_positive_inward() { signs(1.,1.,0.,[9.9,9.7],true); } // 10-rho=+.1 => rho=9.9; first rho>9.9.
#[test] fn m4_ccw_negative_outward() { signs(1.,-1.,0.,[10.1,10.3],false); } // 10-rho=-.1 => rho=10.1; first rho<10.1.
#[test] fn m4_cw_positive_outward() { signs(-1.,1.,0.,[10.1,10.3],false); } // rho-10=+.1 => rho=10.1; first rho<10.1.
#[test] fn m4_cw_negative_inward() { signs(-1.,-1.,0.,[9.9,9.7],true); } // rho-10=-.1 => rho=9.9; first rho>9.9.

#[test]
fn m4_nonzero_offset_is_transported_before_each_sense() {
    // q=.25+sense*C. Thus rho=10-sigma*.25-sigma*sense*C,
    // with C=.1,.3. Offset follows the Axis normal, independently of sense.
    signs(1.,1.,0.25,[9.65,9.45],true);    // 10-.25-.1, 10-.25-.3
    signs(1.,-1.,0.25,[9.85,10.05],false); // 10-.25+.1, 10-.25+.3
    signs(-1.,1.,0.25,[10.35,10.55],false);// 10+.25+.1, 10+.25+.3
    signs(-1.,-1.,0.25,[10.15,9.95],true); // 10+.25-.1, 10+.25-.3
}

#[test]
fn m4_usage_provenance_follows_the_exact_indexes_first_sliceable_association() {
    let text=CURVED.replace("ENDSEC;\nEND-ISO",concat!(
        "#9000=IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,.POSITIVE.,0.25,$);\n",
        "#9001=IFCRELASSOCIATESMATERIAL('last',$,$,$,(#55),#9000);\nENDSEC;\nEND-ISO"));
    let earlier_single=CURVED.replace("#56=IFCRELASSOCIATESMATERIAL",concat!(
        "#9000=IFCMATERIALLAYERSET((#17),'single',$);\n",
        "#9001=IFCMATERIALLAYERSETUSAGE(#9000,.AXIS2.,.POSITIVE.,0.25,$);\n",
        "#9002=IFCRELASSOCIATESMATERIAL('first',$,$,$,(#55),#9001);\n#56=IFCRELASSOCIATESMATERIAL"));
    for source in [text,earlier_single] { with(&source,55,|spec,_,_,_| {
        assert_eq!(spec.source_id,23);
        assert_eq!((spec.sense,spec.offset_m),(-1.,0.));
        assert!((spec.radius_at(0.1).unwrap()-10.1).abs()<1e-12);
    }); }
}

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

fn straight_signs(sigma:f64,sense:f64) {
    let offset=if sense>0. {0.} else {1.};
    let usage=if sense>0. {".AXIS2.,.POSITIVE.,0.)"} else {".AXIS2.,.NEGATIVE.,1.)"};
    let points=if sigma>0. {"(#9000,#9001)"} else {"(#9001,#9000)"};
    let text=STRAIGHT.replace(".AXIS2.,.POSITIVE.,0.)",usage)
        .replace("#26=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));","#26=IFCPRODUCTDEFINITIONSHAPE($,$,(#25,#9003));")
        .replace("ENDSEC;\nEND-ISO",&format!("#9000=IFCCARTESIANPOINT((0.,0.));\n#9001=IFCCARTESIANPOINT((2.,0.));\n#9002=IFCPOLYLINE({points});\n#9003=IFCSHAPEREPRESENTATION(#4,'Axis','Curve2D',(#9002));\nENDSEC;\nEND-ISO"));
    with(&text,27,|spec,traversal,router,decoder| {
        let expected_frame=nalgebra::Matrix4::from_column_slice(&spec.world_from_object);
        let entity=decoder.decode_by_id(27).unwrap();
        let host=body(traversal.product_parts(&entity),router,decoder);
        let frame=nalgebra::Matrix4::from_column_slice(host.values().next().unwrap().object_frame());
        let plan=body(traversal.layer_bands(host,spec).unwrap(),router,decoder);
        let ifc_lite_geometry::program::transactions::LayerInterface::Plane{normal,distance}=plan.layers().unwrap().interfaces[0] else {panic!("plane")};
        let n=nalgebra::Vector3::from(normal);
        let world_normal=frame.transform_vector(&n);
        let world_point=frame.transform_point(&nalgebra::Point3::from(n*distance));
        let expected_normal=expected_frame.transform_vector(&(nalgebra::Vector3::y()*sense));
        let expected_point=expected_frame.transform_point(&nalgebra::Point3::new(0.,offset+sense*0.1,0.));
        assert!((world_normal-expected_normal).norm()<=2.*f64::EPSILON);
        assert!((world_normal.dot(&world_point.coords)-expected_normal.dot(&expected_point.coords)).abs()<=1e-12);
    });
}
// Straight exact semantics fix a=+Y even if the polyline endpoints are reversed.
// sigma=+/- therefore gives the same scalar arithmetic for a given sense.
#[test] fn m4_straight_forward_positive() {straight_signs(1.,1.);} // y=0+.1=.1; first y<.1.
#[test] fn m4_straight_forward_negative() {straight_signs(1.,-1.);} // y=1-.1=.9; first y>.9.
#[test] fn m4_straight_reverse_positive() {straight_signs(-1.,1.);} // y=0+.1=.1; first y<.1.
#[test] fn m4_straight_reverse_negative() {straight_signs(-1.,-1.);} // y=1-.1=.9; first y>.9.

#[test]
fn m4_source_only_eligibility_and_family_refusals() {
    let admit=|text:&str,id| {
        let bundle=SourceBundle::new(text.as_bytes().to_vec()); let mut d=bundle.decoder();
        let mut r=GeometryRouter::with_units(text,&mut d);
        r.set_material_layer_index(Arc::new(MaterialLayerIndex::from_content(text,&mut d)));
        let usages=LayerUsages::from_content(text.as_bytes(),&mut d);
        let e=d.decode_by_id(id).unwrap(); Traversal::layer_admission(&e,&r,&usages,&mut d)
    };
    let single=STRAIGHT.replace("((#80,#81),'layers')","((#80),'layers')");
    assert!(matches!(admit(&single,27).unwrap(),LayerAdmission::None|LayerAdmission::Skip(_)));
    let thin=STRAIGHT.replace("($,0.1,$)","($,0.001,$)");
    assert!(matches!(admit(&thin,27).unwrap(),LayerAdmission::Skip(_)));
    let unsupported=CURVED.replace("IFCCIRCLE(#26,10.)","IFCELLIPSE(#26,10.,9.)");
    assert_eq!(admit(&unsupported,55).unwrap_err(),"layer_axis_family");
    let radius=CURVED.replace(".AXIS2.,.NEGATIVE.,0.,$)",".AXIS2.,.POSITIVE.,10.,$)");
    assert_eq!(admit(&radius,55).unwrap_err(),"layer_radius");
    // #7955 review: the per-model usage table keeps the per-product scan's
    // choice, the first sliceable usage in file order; other materials are skipped.
    let associations=STRAIGHT.replace("#84=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#27),#83);",
        "#78=IFCMATERIAL('plain',$,$);#79=IFCRELASSOCIATESMATERIAL('p',$,$,$,(#27),#78);\n\
         #84=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#27),#83);\n\
         #85=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,.NEGATIVE.,0.);#86=IFCRELASSOCIATESMATERIAL('n',$,$,$,(#27),#85);");
    assert_ne!(associations,STRAIGHT);
    let LayerAdmission::Bands(spec)=admit(&associations,27).unwrap() else { panic!("bands required") };
    assert_eq!(spec.source_id,83);
}
