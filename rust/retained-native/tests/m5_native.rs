// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 core clip witnesses; full corpus/source-oracle qualification is separate.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{ModelOptions, ProductOutcome};
#[path = "../../geometry/tests/support/m5_clips.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
fn worker() -> Option<std::ffi::OsString> {
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib SDK required");
        eprintln!("SKIP M5 native: set IFCLITE_SMLIB_WORKER; not SDK evidence");
    }
    path
}
fn run(text: &str, worker: &std::ffi::OsStr) -> ProductOutcome {
    let mut outcomes=Vec::new();
    ifc_lite_retained_native::run_model_native(SourceBundle::new(text.as_bytes().to_vec()),worker,
        &ModelOptions{ids:Some([13].into_iter().collect()),..Default::default()},|o|outcomes.push(o)).unwrap();
    assert_eq!(outcomes.len(),1,"one atomic publication/refusal");outcomes.pop().unwrap()
}
fn volume(outcome: ProductOutcome, expected: f64) {
    let ProductOutcome::Published(shape)=outcome else {panic!("expected publication: {outcome:?}")};
    let mut actual=metrics::Metrics::default();
    for part in &shape.parts {
        let points:Vec<_>=part.positions.chunks_exact(3).map(|p|metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
        actual.add_mesh(&points,&part.indices).unwrap();
    }
    assert_eq!(actual.defects,0,"closed output");
    assert!(metrics::relative(actual.volume,expected)<=1e-6,"{} vs {expected}",actual.volume);
}
#[test]
fn issue_7955_m5_agreement_and_baked_host_real_sdk() {
    let Some(worker)=worker() else {return};
    // Hand volumes: 4*6*(2-.5), 4*6*.5; mapped host multiplies X/Y by 2/3.
    volume(run(fixture::SOURCE,&worker),36.);
    volume(run(&fixture::SOURCE.replace("#8,.T.","#8,.F."),&worker),12.);
    volume(run(&fixture::mapped(),&worker),216.);
    println!("sdk witness executed: m5_agreement_bake");
}
#[test]
fn issue_7955_m5_three_oblique_chain_real_sdk() {
    let Some(worker)=worker() else {return};
    // Box [-2,2]×[-3,3]×[0,2], clipped by x+z<=2, y+z<=3, -x+z<=2.5.
    // Integrate (4-z)(6-z) for z∈[0,.5], (4.5-2z)(6-z) for z∈[.5,2].
    volume(run(&fixture::chain(),&worker),1229./48.);
    println!("sdk witness executed: m5_three_chain");
}
#[test]
fn issue_7955_m5_consumption_and_unsupported_refuse_real_sdk() {
    let Some(worker)=worker() else {return};
    for (text,code) in [
        (fixture::SOURCE.replace("(0.,0.,0.5)","(0.,0.,3.)"),"empty_result"),
        (fixture::SOURCE.replace(".DIFFERENCE.",".UNION."),"operation_unsupported"),
        (fixture::SOURCE.replace(".DIFFERENCE.",".INTERSECTION."),"operation_unsupported"),
        (fixture::SOURCE.replace("IFCPLANE(#7)","IFCSPHERICALSURFACE(#7,1.)"),"source_invalid"),
    ] {
        let outcome=run(&text,&worker);
        let ProductOutcome::Refused{refusal,origin,..}=outcome else {panic!("expected refusal: {outcome:?}")};
        assert_eq!(refusal.code(),code);
        if code=="empty_result" {
            let origin=origin.unwrap();assert_eq!((origin.site,origin.entity,origin.cause),("halfspace_clip",Some(9),"consumed"));
        }
    }
    println!("sdk witness executed: m5_empty_refusal");
}
