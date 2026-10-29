// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 round 7: actual receipts and independently known solid constraints.
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::{ModelOptions, ProductOutcome, ShapeOnlyProduct};
use ifc_lite_retained_native::oracle::clips::ClipOracle;
#[allow(dead_code)]
#[path = "../../geometry/tests/support/m5_clips.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
#[allow(dead_code)]
#[path = "../examples/compare/checks/mod.rs"]
mod checks;
fn shape(text: &str) -> Option<ShapeOnlyProduct> {
    let Some(worker)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(),"real SDK required");
        eprintln!("SKIP M5 review witnesses: real SDK missing; not evidence");return None;
    };
    let mut outcomes=Vec::new();
    ifc_lite_retained_native::run_model_native(SourceBundle::new(text.as_bytes().to_vec()),worker,
        &ModelOptions {ids:Some([13].into_iter().collect()),..Default::default()},|o|outcomes.push(o)).unwrap();
    assert_eq!(outcomes.len(),1);
    let ProductOutcome::Published(shape)=outcomes.remove(0) else {panic!("required published fixture")};
    Some(shape)
}
fn check(text: &str,shape: &ShapeOnlyProduct) -> Vec<checks::OracleResult> {
    let model=SourceBundle::new(text.as_bytes().to_vec());
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    let oracle=ClipOracle::new(&model,&sources);
    let t=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m5.json")).unwrap();
    checks::check(shape,&checks::SourceContext {product_id:13,analytic:&sources,clips:&oracle},&t)
}
#[test]
fn issue_7955_clipped_union_and_intersection_keep_real_mesh_gates() {
    for (operator,volume) in [("UNION",54.),("INTERSECTION",18.)] {
        let text=fixture::clipped_solid(operator);
        let Some(mut shape)=shape(&text) else {return};
        let part=&shape.parts[0];assert!(part.halfspace_clipped);
        let mut measured=metrics::Metrics::default();
        let points:Vec<_>=part.positions.chunks_exact(3).map(|p|metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
        measured.add_mesh(&points,&part.indices).unwrap();
        assert!(metrics::relative(measured.volume,volume)<1e-9);
        let checks=check(&text,&shape);
        for family in ["clipKeptSideMetres","clipClosure"] {
            assert!(checks.iter().any(|c|c.family==family&&c.gated&&c.pass),"{operator}: missing {family}");
        }
        assert!(checks.iter().any(|c|c.family=="clipVolumeBoundsUnavailable"&&!c.gated&&!c.pass));
        assert!(checks.iter().filter(|c|c.gated).all(|c|c.pass));
        shape.parts[0].world_from_object[14]-=1.;
        assert!(check(&text,&shape).iter().any(|c|c.family=="clipKeptSideMetres"&&c.gated&&!c.pass));
        shape.parts[0].world_from_object[14]+=1.;
        let count=shape.parts[0].indices.len();shape.parts[0].indices.truncate(count-3);
        assert!(check(&text,&shape).iter().any(|c|c.family=="clipClosure"&&c.gated&&!c.pass));
    }
    println!("sdk witness executed: m5_outer_solid_clip");
}
#[test]
fn issue_7955_clip_tolerance_uses_each_parts_actual_receipt() {
    let round=fixture::SOURCE.replace("IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,6.)","IFCCIRCLEPROFILEDEF(.AREA.,$,$,2.)");
    for (text,curves,executed) in [
        (round.clone(),vec![true],vec![true]),
        (round.replace("(0.,0.,0.5)","(0.,0.,-1.)"),vec![true],vec![false]),
        (fixture::SOURCE.replace("'CSG',(#10)","'CSG',(#10,#22)")
            .replace("ENDSEC;END-ISO","#20=IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.);#22=IFCEXTRUDEDAREASOLID(#20,#2,#3,2.);ENDSEC;END-ISO"),vec![false,true],vec![true,false]),
    ] {
        let Some(shape)=shape(&text) else {return};
        assert_eq!(shape.parts.iter().map(|p|p.halfspace_clipped).collect::<Vec<_>>(),executed);
        let checks=check(&text,&shape);
        assert!(checks.iter().filter(|c|c.gated).all(|c|c.pass));
        let parts:Vec<_>=checks.iter().filter_map(|c|c.clip_part.as_ref()).collect();
        assert_eq!(parts.iter().map(|p|p.curved).collect::<Vec<_>>(),curves);
        assert_eq!(parts.iter().map(|p|p.executed).collect::<Vec<_>>(),executed);
        for gate in checks.iter().filter(|c|matches!(c.family,"clipSectionVolumeRelative"|"clipVolumeBoundsRelative")) {
            assert_eq!(gate.limit,if curves[0]&&executed[0]{2e-3}else{1e-6});
        }
    }
    println!("sdk witness executed: m5_part_tolerance");
}
#[test]
fn issue_7955_invalid_agreement_preserves_exact_default_but_fails_oracle() {
    let exact=ifc_lite_processing::process_geometry(fixture::SOURCE.as_bytes());
    let Some(reference)=shape(fixture::SOURCE) else {return};
    for flag in ["$",".U."] {
        let text=fixture::SOURCE.replace("#8,.T.",&format!("#8,{flag}"));
        let actual=ifc_lite_processing::process_geometry(text.as_bytes());
        assert!(!exact.meshes.is_empty());assert_eq!(actual.meshes.len(),exact.meshes.len());
        for (a,b) in actual.meshes.iter().zip(&exact.meshes) {
            assert_eq!(a.positions,b.positions);assert_eq!(a.indices,b.indices);
        }
        let actual=shape(&text).unwrap();
        assert_eq!(actual.parts[0].positions,reference.parts[0].positions);
        assert_eq!(actual.parts[0].indices,reference.parts[0].indices);
        assert!(check(&text,&actual).iter().any(|c|c.family=="clipSourceReadable"&&c.gated&&!c.pass));
    }
    println!("sdk witness executed: m5_invalid_agreement");
}
