// SPDX-License-Identifier: MPL-2.0
//! #7955 hand-derived M4 source witnesses; never read any retained tessellation.
use ifc_lite_retained_native::oracle::layers::expected;
const CURVED:&[u8]=include_bytes!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
const STRAIGHT:&[u8]=include_bytes!("../../../tests/fixtures/cli-retained/layered-wall.ifc");
#[test]
fn m4_source_integrals_match_hand_volumes() {
    let straight=expected(STRAIGHT,&ifc_lite_processing::extract_analytic_quantity_sources(STRAIGHT,None),27).unwrap();
    // x width2, height3; y=[0,.1] and y=[.1,1] give .6 and 5.4 m³.
    for (a,b) in straight.volumes.iter().zip([0.6,5.4]) { assert!((a-b).abs()<1e-11); }
    assert!((straight.opened_volume-6.).abs()<1e-11);
    let curved=expected(CURVED,&ifc_lite_processing::extract_analytic_quantity_sources(CURVED,None),55).unwrap();
    let f=|r:f64|0.5*(r*r-0.25).sqrt()+r*r*(0.5/r).asin();
    let hand:Vec<_>=[(10_f64,10.1_f64),(10.1,10.3),(10.3,10.6)].into_iter().map(|(a,b)|3.*std::f64::consts::PI*(b*b-a*a)/4.-2.*(f(b)-f(a))).collect();
    for (a,b) in curved.volumes.iter().zip(&hand) { assert!((a-b).abs()<1e-10,"{a} vs {b}"); }
    assert!((curved.opened_volume-hand.iter().sum::<f64>()).abs()<1e-10);
    if let Some(path)=std::env::var_os("IFCLITE_M4_EXPECTED") {
        std::fs::write(path,serde_json::to_vec_pretty(&serde_json::json!({"layeredWall":{"id":27,"bandVolumesM3":straight.volumes},"curvedWall":{"id":55,"bandVolumesM3":curved.volumes,"independentProducts":[122,188,254]}})).unwrap()).unwrap();
    }
}
