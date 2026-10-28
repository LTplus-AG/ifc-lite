// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 hand-integrated oracles, independent of any kernel or retained cutter.
use ifc_lite_retained_native::oracle::bounded;
const SOURCE:&[u8]=include_bytes!("../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
#[test]
fn m6_section_partition_matches_hand_integrals_and_overlap() {
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(SOURCE,None);
    let pins:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/expected.d/m6-halfspaces.json")).unwrap();
    for id in [1000,1001,1002,1003,1007,1008,1009,1010,1011,1014,1015] {
        let expected=bounded::expected(SOURCE,&sources,id).unwrap_or_else(||panic!("source oracle #{id}"));
        let volume=expected.section_volume.unwrap_or_else(||panic!("section #{id}"));
        let hand=if id==1011{0.}else{pins["rows"][(id-1000) as usize]["volume"].as_f64().unwrap()};
        assert!((volume-hand).abs()<=1e-10*hand.abs().max(1.),"#{id}: {volume} vs {hand}");
        assert!((expected.host_volume-64.).abs()<1e-12);
    }
}
#[test]
fn m6_outside_material_uses_original_boundary_not_partition_edges() {
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(SOURCE,None);
    let e=bounded::expected(SOURCE,&sources,1000).unwrap();
    assert!(e.removed_clearance([1.5,1.5,3.])>0.4,"internal triangle diagonal is material");
    assert_eq!(e.removed_clearance([3.,1.5,3.]),0.);
    assert_eq!(e.removed_clearance([1.5,1.5,2.]),0.);
    assert_eq!(e.removed_clearance([0.5,1.5,3.]),0.);
    let e=bounded::expected(SOURCE,&sources,1002).unwrap();
    assert_eq!(e.removed_clearance([1.5,1.5,3.9]),0.,"L notch is outside");
    assert!(e.removed_clearance([0.5,1.5,3.9])>0.4);
    let arc=bounded::expected(SOURCE,&sources,1005).unwrap();
    assert!(arc.curved);assert!(arc.removed_clearance([0.5,0.5,3.])>0.4);
    assert_eq!(arc.removed_clearance([1.5,1.5,3.]),0.);
}
