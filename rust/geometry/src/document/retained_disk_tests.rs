// SPDX-License-Identifier: MPL-2.0
//! Exact source-to-coefficient invariants; these do not execute SDK geometry.
use super::*;
use crate::analytic::extract_swept_disk;
use ifc_lite_core::{build_entity_index, EntityDecoder};
fn read(data:&str,u:f64)->RetainedSweptDisk {
    let mut decoder=EntityDecoder::with_index(data.as_bytes(),build_entity_index(data.as_bytes()));
    let entity=decoder.decode_by_id(9).unwrap();
    RetainedSweptDisk {solid_id:9,source:extract_swept_disk(&entity,&mut decoder).unwrap(),length_unit_scale:u,source_epoch:1,source_revision:1}
}
fn number(bytes:&[u8],offset:usize)->f64 {f64::from_le_bytes(bytes[offset..offset+8].try_into().unwrap())}
#[test]
fn original_rational_weights_knots_and_trim_survive_unit_conversion_and_rebase() {
    let data="#1=IFCCARTESIANPOINT((1000000000.,0.,0.));#2=IFCCARTESIANPOINT((1000000000.,0.,5000.));#3=IFCRATIONALBSPLINECURVEWITHKNOTS(1,(#1,#2),.UNSPECIFIED.,.F.,.F.,(2,2),(2.,6.),.UNSPECIFIED.,(2.,3.));#9=IFCSWEPTDISKSOLID(#3,250.,$,3.,5.);";
    let recipe=read(data,0.001);let original=recipe.source.clone();let payload=lower(&recipe).unwrap();
    assert_eq!(recipe.source,original);
    assert_eq!(payload.format,2);
    assert_eq!(number(&payload.bytes,16),0.25);
    assert_eq!(number(&payload.bytes,56),3.);assert_eq!(number(&payload.bytes,64),5.);
    assert_eq!(number(&payload.bytes,72),0.);assert_eq!(number(&payload.bytes,96),2.);
    assert_eq!(number(&payload.bytes,120),5.);assert_eq!(number(&payload.bytes,128),3.);
    assert_eq!(payload.source_from_evaluation[12],1e9);
    assert_eq!(payload.evaluation_from_source[12],-1e6);
    assert_eq!(number(&payload.bytes,136),2.);assert_eq!(number(&payload.bytes,152),6.);
}
#[test]
fn circular_conic_conversion_keeps_original_circle_and_parameter_convention() {
    let data="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCCIRCLE(#2,4.);#4=IFCTRIMMEDCURVE(#3,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267948966)),.T.,.PARAMETER.);#9=IFCSWEPTDISKSOLID(#4,0.25,$,$,$);";
    let recipe=read(data,1.);let original=recipe.source.clone();let payload=lower(&recipe).unwrap();
    assert_eq!(recipe.source,original);
    // A quarter-circle becomes its exact quadratic rational conic, not a fit.
    assert_eq!(u32::from_le_bytes(payload.bytes[40..44].try_into().unwrap()),2);
    assert!((number(&payload.bytes,128)-0.5f64.sqrt()).abs()<1e-14);
    let source=recipe.source.source.as_ref().unwrap();
    assert_eq!(source.records[&3].ifc_type_name,"IfcCircle");
    assert!(source.records[&4].attributes.contains_key("Trim1"));
}
#[test]
fn unsupported_hollow_and_closed_disk_keep_named_refusals() {
    let base="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((0.,0.,5.));#3=IFCPOLYLINE((#1,#2));#9=IFCSWEPTDISKSOLID(#3,0.25,0.1,$,$);";
    assert!(matches!(lower(&read(base,1.)),Err(RetainedRefusal::UnsupportedSource(_))));
    let circle="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCCIRCLE(#2,4.);#9=IFCSWEPTDISKSOLID(#3,0.25,$,$,$);";
    assert!(matches!(lower(&read(circle,1.)),Err(RetainedRefusal::UnsupportedSource(_))));
}
