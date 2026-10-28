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
    let mut result = metrics::Metrics::default();
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
    let wall = shape(&results,55);
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
        let actual = part.capped_volume_m3.unwrap();
        let proxy = measure(shape(&results,id));
        close(proxy.volume,expected,tolerance); close(actual,expected,tolerance); close(actual,proxy.volume,tolerance);
        println!("M4 independent band: {}",serde_json::json!({"index":index,"radii":[a,b],"handVolume":expected,"cappedVolume":actual,"proxy":id,"proxyVolume":proxy.volume}));
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
    // y=[0,1], x width2, height3: first .1*2*3=.6, remainder .9*2*3=5.4.
    for (part,expected) in wall.parts.iter().zip([0.6,5.4]) { close(part.capped_volume_m3.unwrap(),expected,1e-6); }
    let measured = measure(wall); close(measured.volume,6.,1e-6); assert_eq!(measured.defects,0);
    assert!(wall.max_snap_metres<=1e-6);
    println!("sdk witness executed: m4_straight_bands");
}
