// SPDX-License-Identifier: MPL-2.0
//! #7955 independent membership oracle for the actual shared issued operation graph.
use super::*;
use std::collections::HashMap;
use crate::program::RetainedFiniteBoundary;
fn source_operations(text: &str) -> (bool, Vec<RetainedPlanOperation>) {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text,&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity,contract());
    let operations = drive(&mut program,&router,&mut decoder);
    (program.finish().is_ok(),operations)
}
fn inside_host(p: [f64;3]) -> bool { p[0].abs()<1. && p[1].abs()<2. && p[2]>0. && p[2]<3. }
fn expected(name: &str, p: [f64;3]) -> bool {
    let cut = if name == "finite_box_false_rotated" {
        p[0].abs()<0.5 && p[1].abs()<0.25 && p[2]>1. && p[2]<1.25
    } else if name.starts_with("finite_box") {
        p[0].abs()<0.25 && p[1].abs()<0.5 && p[2]>0.5 && p[2]<1.
    } else if name.starts_with("finite_polygon_placed") {
        p[0].abs()<1. && p[1]>0. && p[1]<1. && p[2]<1.
    } else {
        p[0].abs()<0.5 && p[1].abs()<1. && p[2]<1.
            && (!name.starts_with("finite_concave_l") || p[0]<0. || p[1]<0.)
    };
    inside_host(p) && if name.ends_with("difference") { !cut } else { cut }
}
fn evaluate(operations: &[RetainedPlanOperation], point: [f64;3]) -> bool {
    let mut values: HashMap<crate::program::LogicalRetainedDefinition, bool> = HashMap::new();
    for operation in operations {
        let value = match operation.kind() {
            RetainedOperationKind::Construction(_) => inside_host(point),
            RetainedOperationKind::UnaryClip { input,clip } => {
                let p = nalgebra::Matrix4::from_column_slice(&clip.input_frame).try_inverse().unwrap()
                    * nalgebra::Vector4::new(point[0],point[1],point[2],1.);
                let plane = clip.local_plane;
                let dot = (p.x-plane[0])*plane[3]+(p.y-plane[1])*plane[4]+(p.z-plane[2])*plane[5];
                let selected = if clip.keeps_negative_side() { dot<=0. } else { dot>=0. };
                values[input.definition()] && match clip.mode { RetainedClipMode::Intersection=>selected,RetainedClipMode::Difference=>!selected }
            }
            RetainedOperationKind::Boolean {inputs,operation} => {
                let a = values[inputs[0].definition()]; let b = values[inputs[1].definition()];
                match operation {crate::BoolOp::Union=>a||b,crate::BoolOp::Intersection=>a&&b,crate::BoolOp::Difference=>a&&!b,crate::BoolOp::Unknown=>panic!("unknown Boolean")}
            }
            RetainedOperationKind::Affine { .. } => panic!("fixture has no mapped operands"),
        };
        values.insert(operation.value().definition().clone(),value);
    }
    values[operations.last().unwrap().value().definition()]
}
#[test]
fn j1_finite_membership_oracle() {
    for case in ifc_lite_testkit::retained_finite_clip::cases() {
        let (program,operations) = source_operations(&case.source);
        assert!(program,"finite source must lower: {}",case.name);
        assert!(operations.len()>2);
        // Deliberately off all authored boundary coordinates. Includes points
        // outside the finite domain but inside the infinite base halfspace.
        for x in [-0.91,-0.41,-0.11,0.13,0.39,0.89] {
            for y in [-1.81,-0.81,-0.21,0.23,0.79,1.79] {
                for z in [0.13,0.73,1.13,1.73,2.73] {
                    let point = [x,y,z];
                    assert_eq!(evaluate(&operations,point),expected(case.name,point),
                        "FINITE_MEMBERSHIP {} {point:?}",case.name);
                }
            }
        }
    }
}
#[test]
fn j1_finite_source_provenance() {
    for case in ifc_lite_testkit::retained_finite_clip::cases() {
        let (_,operations) = source_operations(&case.source);
        for operation in operations.iter().skip(1) {
            if let RetainedOperationKind::UnaryClip {clip,..} = operation.kind() {
                assert_eq!((clip.source.half_space_id,clip.source.boolean_id),(203,13));
                assert_eq!((clip.source.source_epoch,clip.source.source_revision),(7,9));
                assert_eq!(clip.source.authored_agreement,Some(case.name!="finite_box_false_rotated"));
                let finite = clip.finite.as_ref().expect("FINITE_SOURCE boundary identity");
                match finite.boundary() {
                    RetainedFiniteBoundary::Box {enclosure_id,corner,dimensions,placement} => {
                        assert_eq!(*enclosure_id,400); assert_eq!(corner.source_id,401);
                        assert_eq!(placement.position_id,201);
                        assert_eq!(dimensions[0],if case.name.ends_with("millimetres") {500.} else {0.5});
                    }
                    RetainedFiniteBoundary::Polygon {boundary_id,points,..} => {
                        assert_eq!(*boundary_id,400);assert_eq!(points.first().unwrap().values,points.last().unwrap().values);
                    }
                }
                if finite.is_base() { assert_eq!(finite.source_plane(),&clip.source_plane); }
                else { assert!(!clip.keeps_negative_side(),"FINITE_SIDE boundary normals are inward independently of AgreementFlag"); }
            }
        }
    }
}
#[test]
fn j1_finite_malformed_is_atomic() {
    let polygon = ifc_lite_testkit::retained_finite_clip::cases().remove(0).source;
    let boxed = ifc_lite_testkit::retained_finite_clip::boxed();
    for (name,text) in [
        ("open",polygon.replace("#403,#404,#401", "#403,#404,#402")),
        ("crossing",polygon.replace("#401,#402,#403,#404,#401", "#401,#403,#402,#404,#401")),
        ("duplicate",polygon.replace("#401,#402,#403,#404,#401", "#401,#402,#402,#404,#401")),
        ("missing",polygon.replace("#403,#404,#401", "#403,#999,#401")),
        ("dimension",polygon.replace("((-0.5,-1.))", "((-0.5,-1.,0.))")),
        ("zero box",boxed.replace("#401,0.5,1.,0.75", "#401,0.,1.,0.75")),
        ("negative box",boxed.replace("#401,0.5,1.,0.75", "#401,-0.5,1.,0.75")),
        ("bad enclosure",boxed.replace("#400=IFCBOUNDINGBOX", "#400=IFCCARTESIANPOINT")),
        ("missing agreement",boxed.replace("#202,.T.", "#202,$")),
        ("parallel axes",boxed.replace("#200,#15,$", "#200,#15,#15")),
    ] {
        let (program,operations)=source_operations(&text);
        assert!(!program,"FINITE_REFUSAL {name}");
        assert_eq!(operations.len(),1,"FINITE_ATOMIC {name}: no component may be admitted before full source validation");
    }
}

#[test]
fn j1_finite_authored_960_first_boundary_source_checkpoint() {
    let Some(text)=ifc_lite_testkit::fixture_text("issues/960_house_segmented_roof_clip.ifc") else { return; };
    let source=SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder=source.decoder();
    let router=GeometryRouter::with_units(&text,&mut decoder);
    let entity=decoder.decode_by_id(2152).unwrap();
    let mut program=RetainedProgram::product_parts(&entity,contract());
    let operations=drive(&mut program,&router,&mut decoder);
    let clip=operations.iter().find_map(|operation| match operation.kind() {
        RetainedOperationKind::UnaryClip {clip,..} if clip.source.half_space_id==1938=>Some(clip),
        _=>None,
    }).expect("AUTHORED_960 first finite boundary must reach the common source controller");
    assert_eq!(clip.source.length_unit_scale,0.001);
    assert_eq!(clip.source.authored_agreement,Some(false));
    assert_eq!(clip.source.base_surface_id,1928);
    let RetainedFiniteBoundary::Polygon {boundary_id,placement,points,..}=
        clip.finite.as_ref().unwrap().boundary() else {panic!("authored polygon")};
    assert_eq!(*boundary_id,1937);
    assert_eq!(placement.position_id,1932);
    assert_eq!(points.iter().map(|p|p.source_id).collect::<Vec<_>>(),vec![1933,1934,1935,1936]);
    assert_eq!(points[1].values,[-1850.,-7500.,0.]);
    assert_eq!(points[2].values,[812.15380859375,-7500.,0.]);
    // This is source capture only. A downstream refusal is not reclassified as
    // a successful numerical product, nor as a fixture skip.
}
