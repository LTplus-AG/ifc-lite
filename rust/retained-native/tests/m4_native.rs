// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M4 independent authored-band acceptance against the real SDK.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{ModelOptions, ProductOutcome, ShapeOnlyProduct};
use ifc_lite_retained_native::run_model_native;
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
const CURVED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
const STRAIGHT: &str = include_str!("../../../tests/fixtures/cli-retained/layered-wall.ifc");
fn run(text: &str, ids: &[u32]) -> Option<Vec<ProductOutcome>> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "M4 requires real SDK");
        eprintln!("SKIP M4: set IFCLITE_SMLIB_WORKER; not acceptance evidence"); return None;
    };
    let mut results = Vec::new();
    run_model_native(SourceBundle::new(text.as_bytes().to_vec()),path,
        &ModelOptions { ids: Some(ids.iter().copied().collect()), ..Default::default() },
        |o| results.push(o)).unwrap();
    Some(results)
}
fn shape(results: &[ProductOutcome], id: u32) -> &ShapeOnlyProduct {
    results.iter().find_map(|o| match o { ProductOutcome::Published(p) if p.product_id==id => Some(p), _=>None })
        .unwrap_or_else(|| panic!("#{id} not published: {results:?}"))
}
fn measure(p: &ShapeOnlyProduct) -> metrics::Metrics {
    let mut result = if p.parts.iter().any(|part| part.layer.is_some()) {
        metrics::Metrics::assembly()
    } else { metrics::Metrics::default() };
    for part in &p.parts {
        // All parts share the same host evaluation frame. Avoid transforming
        // exact-key seams independently through absolute survey coordinates.
        let points: Vec<_> = part.positions.chunks_exact(3).map(|v|[v[0],v[1],v[2]]).collect();
        result.add_mesh(&points,&part.indices).unwrap();
    }
    result
}
fn close(actual: f64, expected: f64, tolerance: f64) {
    let relative = metrics::relative(actual,expected);
    assert!(relative<=tolerance,"{actual} vs {expected}: relative {relative} > {tolerance}");
}
#[test]
fn issue_7955_m4_curved_ifc_normal_matches_independently_authored_bands() {
    let Some(results) = run(CURVED,&[55,122,188,254]) else {return;};
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(CURVED.as_bytes(),None);
    let independent=ifc_lite_retained_native::oracle::layers::expected(CURVED.as_bytes(),&sources,55).expect("IFC source oracle");
    let wall = shape(&results,55);
    assert_band_faces(wall);
    assert_eq!(wall.parts.len(),3); assert_eq!(wall.cuts,1);
    let limits: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m4.json")).unwrap();
    let tolerance = limits["layerBandVolumeRelative"]["curved"].as_f64().unwrap();
    let mut sum = 0.;
    for (index,(a,b,id,material)) in [(10_f64,10.1_f64,122,16),(10.1,10.3,188,18),(10.3,10.6,254,20)].into_iter().enumerate() {
        // IFC rule: q=10-rho, NEGATIVE sense => w=rho-10. C=.1,.3.
        // Annular sector angle pi/2, height3; subtract central |y|<.5 door height2.
        // Integral over y of sqrt(r²-y²) is F(r); x=9..12 covers every band.
        let f = |r:f64| 0.5*(r*r-0.25).sqrt()+r*r*(0.5/r).asin();
        let expected = 3.*std::f64::consts::PI*(b*b-a*a)/4.-2.*(f(b)-f(a));
        let part = &wall.parts[index];
        let tag = part.layer.unwrap(); assert_eq!(usize::from(tag.index),index); assert_eq!(tag.material_id,material);
        close(independent.volumes[index],expected,1e-10);
        let proxy_opening = [129,195,261][index];
        let proxy_source = ifc_lite_retained_native::oracle::openings::prism_result_volume(
            &sources,id,&[proxy_opening]).expect("independent authored proxy source");
        close(proxy_source,expected,1e-10);
        let actual = part.capped_volume_m3.unwrap();
        let proxy = measure(shape(&results,id));
        close(proxy.volume,expected,tolerance); close(actual,proxy_source,tolerance); close(actual,proxy.volume,tolerance);
        println!("M4 independent band: {}",serde_json::json!({"index":index,"radii":[a,b],"handVolume":expected,"cappedVolume":actual,"proxy":id,"proxySourceVolume":proxy_source,"proxyVolume":proxy.volume}));
        sum += actual;
    }
    let measured = measure(wall); assert_eq!(measured.defects,0); close(measured.volume,sum,tolerance);
    assert!(wall.max_snap_metres<=1e-3);
    assert!(!wall.obligations.0.contains(&ifc_lite_geometry::program::transactions::Requirement::MaterialLayers));
    println!("sdk witness executed: m4_curved_authored_bands");
}
#[test]
fn issue_7955_m4_straight_hand_volumes_and_closed_union() {
    let Some(results) = run(STRAIGHT,&[27]) else {return;};
    let wall = shape(&results,27); assert_eq!(wall.parts.len(),2);
    assert_band_faces(wall);
    assert!(wall.parts.iter().flat_map(|p| &p.faces.as_ref().unwrap().table).all(|k| k.item == 19 && k.via == 0));
    // y=[0,1], x width2, height3: first .1*2*3=.6, remainder .9*2*3=5.4.
    for (part,expected) in wall.parts.iter().zip([0.6,5.4]) { close(part.capped_volume_m3.unwrap(),expected,1e-6); }
    let measured = measure(wall); close(measured.volume,6.,1e-6); assert_eq!(measured.defects,0);
    assert!(wall.max_snap_metres<=1e-6);
    println!("sdk witness executed: m4_straight_bands");
}

#[test]
fn issue_7955_m4_opening_precedes_bands_and_failed_intersection_is_atomic() {
    use ifc_lite_retained_native::{NativeWorker,NativeReceipt,NativeDomain,block_on};
    use ifc_lite_processing::element::retained_runtime::*;
    use ifc_lite_geometry::BoolOp;
    use std::{rc::Rc,cell::RefCell};
    let Some(path)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(),"real SDK required");
        eprintln!("SKIP M4 fault witness: real SDK missing"); return;
    };
    struct Observed { inner:NativeWorker, calls:Rc<RefCell<Vec<BoolOp>>> }
    impl RetainedRuntime for Observed {
        type Receipt=NativeReceipt;
        fn domain(&self)->NativeDomain {self.inner.domain()}
        fn incarnation(&self)->u64 {self.inner.incarnation()}
    }
    impl AsyncRetainedExecutor for Observed {
        async fn invoke(&mut self, call:Invocation<'_,NativeReceipt>,limits:NumericalLimits)->Result<NativeReceipt,RuntimeFault> {
            if let Invocation::Boolean{operation,..}=&call {
                self.calls.borrow_mut().push(*operation);
                if *operation==BoolOp::Intersection && self.calls.borrow().iter().filter(|&&o|o==BoolOp::Intersection).count()==2 {
                    return Err(RuntimeFault::kernel(7,"M4 injected second Intersection failure"));
                }
            }
            self.inner.invoke(call,limits).await
        }
    }
    let calls=Rc::new(RefCell::new(Vec::new())); let mut results=Vec::new();
    block_on(run_model(SourceBundle::new(CURVED.as_bytes().to_vec()),
        &ModelOptions{ids:Some([55,122].into_iter().collect()),..Default::default()},
        ||NativeWorker::spawn(&path).map(|inner|Observed{inner,calls:calls.clone()}),|o|results.push(o))).unwrap();
    assert_eq!(results.len(),2);
    assert!(matches!(results[0],ProductOutcome::Refused{product_id:55,refusal:RetainedProductRefusal::KernelFailure{status:7},..}));
    shape(&results,122);
    assert_eq!(*calls.borrow(),[BoolOp::Difference,BoolOp::Intersection,BoolOp::Intersection,BoolOp::Difference]);
    println!("sdk witness executed: m4_order_atomicity");
}

#[test]
fn issue_7955_m4_single_and_thin_collapsed_layers_publish_unsliced() {
    for text in [STRAIGHT.replace("((#80,#81),'layers')","((#80),'layers')"),
        STRAIGHT.replace("($,0.1,$)","($,0.001,$)")] {
        let Some(results)=run(&text,&[27]) else {return;};
        let product=shape(&results,27); assert_eq!(product.parts.len(),1);
        assert!(product.parts[0].layer.is_none()); close(measure(product).volume,6.,1e-6);
        assert!(!product.obligations.0.contains(&ifc_lite_geometry::program::transactions::Requirement::MaterialLayers));
    }
    println!("sdk witness executed: m4_unsliced_skips");
}

#[test]
fn issue_7955_m4_synthetic_bands_and_refusals() {
    let text=include_str!("../../../tests/fixtures/synthetic-retained/f-g-layers.ifc");
    // Opus review and IFC4 EXPRESS validation/roundtrip accepted 2026-10-28.
    let Some(results)=run(text,&[1027,2027,3055,4055,5027,6027,7027,8027,9027,10027,11027,13055]) else {return;};
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    for id in [1027,2027,3055,4055,5027,6027,7027,13055] {
        let product=shape(&results,id);
        assert_band_faces(product);
        let oracle=ifc_lite_retained_native::oracle::layers::expected(text.as_bytes(),&sources,id).unwrap();
        let tolerance=if oracle.curved {2e-3} else {1e-6};
        for part in &product.parts {
            let tag=part.layer.unwrap(); close(part.capped_volume_m3.unwrap(),oracle.volumes[usize::from(tag.index)],tolerance);
        }
        let measured=measure(product); assert_eq!(measured.defects,0); close(measured.volume,oracle.opened_volume,tolerance);
    }
    let single=shape(&results,10027); assert_eq!(single.parts.len(),1); assert!(single.parts[0].layer.is_none()); close(measure(single).volume,3.6,1e-6);
    for (id,code) in [(8027,"material_layer_strategy"),(9027,"layer_caps_unresolved"),(11027,"operation_unsupported")] {
        assert!(results.iter().any(|o|matches!(o,ProductOutcome::Refused{product_id,refusal,..} if *product_id==id && refusal.code()==code)),"#{id} expected {code}: {results:?}");
    }
    println!("sdk witness executed: m4_synthetic");
}

// #7955 M4/M11-F: every final triangle has a host/opening source key,
// including rim-split children. Cutter usage IDs must never become face keys.
fn assert_band_faces(product: &ShapeOnlyProduct) {
    use std::collections::{BTreeMap, BTreeSet};
    assert!(!product.obligations.0.contains(&ifc_lite_geometry::program::transactions::Requirement::PersistentFaces));
    let mut qualified = BTreeSet::new();
    for part in &product.parts {
        let band = part.layer.expect("band");
        let faces = part.faces.as_ref().expect("persistent face proof");
        assert_eq!(faces.triangles.len(), part.indices.len()/3);
        assert_eq!(part.revision_local_faces.len(), faces.triangles.len());
        let mut kernel_keys = BTreeMap::new();
        for (&key, &kernel) in faces.triangles.iter().zip(&part.revision_local_faces) {
            let key = &faces.table[key as usize];
            assert!(key.role.ends_with(&format!(";band({})", band.index)));
            if let Some(previous) = kernel_keys.insert(kernel, key) { assert_eq!(previous, key); }
        }
        for key in &faces.table { assert!(qualified.insert(key.to_string())); }
    }
}
