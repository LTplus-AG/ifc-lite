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
    // Hand volumes: 4*6*(2-.5), 4*6*.5.
    volume(run(fixture::SOURCE,&worker),36.);
    volume(run(&fixture::SOURCE.replace("#8,.T.","#8,.F."),&worker),12.);
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

#[test]
fn issue_7955_m5_full_synthetic_hand_oracle_and_native_reference() {
    let Some(worker)=worker() else{return};
    let text=include_str!("../../../tests/fixtures/synthetic-retained/f-e-clips.ifc");
    let expected:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/expected.d/m5.json")).unwrap();
    let rows=expected["synthetic"].as_array().unwrap();
    let mut outcomes=Vec::new();
    ifc_lite_retained_native::run_model_native(SourceBundle::new(text.as_bytes().to_vec()),&worker,
        &ModelOptions{ids:Some(rows.iter().map(|r|r["id"].as_u64().unwrap() as u32).collect()),..Default::default()},|o|outcomes.push(o)).unwrap();
    assert_eq!(outcomes.len(),rows.len());let mut reference=Vec::new();
    for (outcome,row) in outcomes.iter().zip(rows) {
        let id=row["id"].as_u64().unwrap() as u32;
        match outcome {
            ProductOutcome::Published(shape)=>{
                assert_eq!(shape.product_id,id);assert_eq!(row["code"],"published");
                let mut actual=metrics::Metrics::default();
                for part in &shape.parts {
                    let points:Vec<_>=part.positions.chunks_exact(3).map(|p|metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
                    actual.add_mesh(&points,&part.indices).unwrap();
                }
                let expected=row["volume"].as_f64().unwrap();
                let limit=if row["case"].as_str().unwrap().starts_with("f "){2e-3}else{1e-6};
                assert_eq!(actual.defects,0,"#{id} closure");
                assert!(metrics::relative(actual.volume,expected)<=limit,"#{id} {} vs {expected}",actual.volume);
                reference.push(serde_json::json!({"id":id,"code":"published","volume":actual.volume}));
            }
            ProductOutcome::Refused{product_id,refusal,origin,..}=>{
                assert_eq!(*product_id,id);assert_eq!(row["code"],refusal.code(),"#{id}: {outcome:?}");
                let origin=origin.as_ref().expect("typed source origin");
                assert_eq!(row["origin"]["site"],origin.site);
                assert_eq!(row["origin"]["entity"],origin.entity.unwrap());
                assert_eq!(row["origin"]["cause"],origin.cause);
                reference.push(serde_json::json!({"id":id,"code":refusal.code()}));
            }
        }
    }
    // This deliberately invalid IFC is a controller extension, not qualification.
    // Its measured volume is only transported for native/browser parity.
    let adversarial=include_str!("../../../tests/fixtures/synthetic-retained/m5-adversarial-nonschema-mapped-operand.ifc");
    let mut extension=Vec::new();
    ifc_lite_retained_native::run_model_native(SourceBundle::new(adversarial.as_bytes().to_vec()),&worker,
        &ModelOptions{ids:Some([27].into_iter().collect()),..Default::default()},|o|extension.push(o)).unwrap();
    assert_eq!(extension.len(),1);
    let ProductOutcome::Published(shape)=&extension[0] else {panic!("observed extension outcome changed: {:?}",extension[0])};
    let mut measured=metrics::Metrics::default();
    for part in &shape.parts {
        let points:Vec<_>=part.positions.chunks_exact(3).map(|p|metrics::transform(&part.world_from_object,[p[0],p[1],p[2]])).collect();
        measured.add_mesh(&points,&part.indices).unwrap();
    }
    if let Some(path)=std::env::var_os("IFCLITE_M5_REFERENCE"){
        let reference=serde_json::json!({"synthetic":reference,"adversarial":{"id":27,"code":"published","volume":measured.volume}});
        std::fs::write(path,serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    }
    println!("sdk witness executed: m5_synthetic");
}

#[test]
fn issue_7955_m5_committed_corpus_matches_source_sections() {
    let Some(worker)=worker() else{return};
    use ifc_lite_retained_native::oracle::clips;
    for (text,ids) in [
        (include_str!("../../../apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc"),vec![67536,75347]),
        (include_str!("../../geometry/tests/fixtures/issue_5314_halfspace_edge.ifc"),vec![30]),
    ] {
        let model=SourceBundle::new(text.as_bytes().to_vec());
        let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
        let mut outcomes=Vec::new();
        ifc_lite_retained_native::run_model_native(model.clone(),&worker,
            &ModelOptions{ids:Some(ids.iter().copied().collect()),..Default::default()},|o|outcomes.push(o)).unwrap();
        assert_eq!(outcomes.len(),ids.len());
        for (outcome,id) in outcomes.into_iter().zip(ids) {
            let expected=clips::expected(&model,&sources,id).unwrap().unwrap();
            volume(outcome,expected.section_volume().expect("required source section"));
        }
    }
    println!("sdk witness executed: m5_corpus");
}
