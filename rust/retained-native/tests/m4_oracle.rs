// SPDX-License-Identifier: MPL-2.0
#![cfg(feature="retained-runtime")]
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
        let bytes=include_bytes!("../../../tests/fixtures/synthetic-retained/f-g-layers.ifc");
        let sources=ifc_lite_processing::extract_analytic_quantity_sources(bytes,None);
        let synthetic:Vec<_>=[1027,2027,3055,4055,5027,6027,7027,13055].into_iter().map(|id| {
            let oracle=expected(bytes,&sources,id).unwrap();
            serde_json::json!({"id":id,"bandVolumesM3":oracle.volumes,"curved":oracle.curved})
        }).collect();
        std::fs::write(path,serde_json::to_vec_pretty(&serde_json::json!({"layeredWall":{"id":27,"bandVolumesM3":straight.volumes,"curved":false},"curvedWall":{"id":55,"bandVolumesM3":curved.volumes,"curved":true,"independentProducts":[122,188,254]},"synthetic":synthetic})).unwrap()).unwrap();
    }
}

#[test]
fn m4_synthetic_source_volumes_are_independently_derived() {
    let bytes=include_bytes!("../../../tests/fixtures/synthetic-retained/f-g-layers.ifc");
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(bytes,None);
    for (id,hand) in [(1027,vec![0.6,1.2,1.8]),(2027,vec![0.6,1.2,1.8]),
        (5027,vec![0.2,0.4,0.6]),(6027,vec![0.6,3.]),(7027,vec![2.4,1.2,0.])] {
        let oracle=expected(bytes,&sources,id).unwrap(); assert_eq!(oracle.volumes.len(),hand.len());
        for (a,b) in oracle.volumes.iter().zip(hand) {assert!((a-b).abs()<1e-8,"#{id}: {a} vs {b}");}
    }
    // pi/2 annular sector with height3; the second case's .2*.1*1 door
    // lies strictly between rho=10.3 and 10.6, removing .02 m³ only there.
    for id in [3055,4055] {
        let oracle=expected(bytes,&sources,id).unwrap();
        for (k,(a,b)) in [(10_f64,10.1_f64),(10.1,10.3),(10.3,10.6)].into_iter().enumerate() {
            let hand=3.*std::f64::consts::PI*(b*b-a*a)/4.-if id==4055 && k==2 {0.02} else {0.};
            assert!((oracle.volumes[k]-hand).abs()<1e-9,"#{id} band{k}: {} vs {hand}",oracle.volumes[k]);
        }
    }
}


#[test]
fn m4_inward_stack_source_integral() {
    let bytes=include_bytes!("../../../tests/fixtures/synthetic-retained/f-g-layers.ifc");
    let source=ifc_lite_processing::extract_analytic_quantity_sources(bytes,None);
    let oracle=expected(bytes,&source,13055).unwrap();
    for (value,(inner,outer)) in oracle.volumes.iter().zip([(9.9_f64,10_f64),(9.7,9.9),(9.4,9.7)]) {
        let hand=3.*std::f64::consts::PI*(outer*outer-inner*inner)/4.;
        assert!((value-hand).abs()<1e-9);
    }
}

#[test]
fn m4_source_association_order_matches_the_hand_authored_stack() {
    let original=std::str::from_utf8(CURVED).unwrap();
    let later=original.replace("ENDSEC;\nEND-ISO",concat!(
        "#9000=IFCMATERIALLAYERSETUSAGE(#22,.AXIS2.,.POSITIVE.,0.25,$);\n",
        "#9001=IFCRELASSOCIATESMATERIAL('last',$,$,$,(#55),#9000);\nENDSEC;\nEND-ISO"));
    let earlier=original.replace("#56=IFCRELASSOCIATESMATERIAL",concat!(
        "#9000=IFCMATERIALLAYERSET((#17,#9003),'one-positive-layer',$);\n",
        "#9001=IFCMATERIALLAYERSETUSAGE(#9000,.AXIS2.,.POSITIVE.,0.25,$);\n",
        "#9002=IFCRELASSOCIATESMATERIAL('first',$,$,$,(#55),#9001);\n",
        "#9003=IFCMATERIALLAYER(#16,0.,$,$,$,$,$);\n#56=IFCRELASSOCIATESMATERIAL"));
    for text in [later,earlier] {
        let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
        let oracle=expected(text.as_bytes(),&sources,55).unwrap();
        let f=|r:f64|0.5*(r*r-0.25).sqrt()+r*r*(0.5/r).asin();
        for (volume,(a,b)) in oracle.volumes.iter().zip([(10_f64,10.1_f64),(10.1,10.3),(10.3,10.6)]) {
            // The valid NEGATIVE stack remains rho=10..10.1..10.3..10.6.
            let hand=3.*std::f64::consts::PI*(b*b-a*a)/4.-2.*(f(b)-f(a));
            assert!((volume-hand).abs()<1e-10);
        }
    }
}

// #7955 review: planar interfaces do not make an arc-profile host linear.
#[test]
fn m4_planar_layer_source_keeps_host_curvature_and_hand_volumes() {
    let text=std::str::from_utf8(CURVED).unwrap().lines()
        .filter(|line|!line.contains("IFCRELVOIDSELEMENT"))
        .collect::<Vec<_>>().join("\n")
        .replace(".AXIS2.,.NEGATIVE.,0.,$)",".AXIS3.,.POSITIVE.,0.,$)");
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    let oracle=expected(text.as_bytes(),&sources,55).unwrap();
    assert!(oracle.curved);
    let area=std::f64::consts::PI*(10.6_f64.powi(2)-10_f64.powi(2))/4.;
    for (volume,height) in oracle.volumes.iter().zip([0.1,0.2,2.7]) {
        assert!((volume-area*height).abs()<1e-10);
    }
    assert!((oracle.opened_volume-area*3.).abs()<1e-10);
}
