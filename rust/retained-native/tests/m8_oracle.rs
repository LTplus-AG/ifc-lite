// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_retained_native::oracle::{convex::{Convex, difference_volume}, retrace};
#[test]
fn issue_3641_hand_derived_quadrilateral_and_spur() {
    let points = [[0.,0.,0.],[870.,0.,0.],[1400.,-900.,0.],[4500.,-900.00001,0.],[4500.,0.,0.]];
    // Rectangle 3630*900 minus triangle 530*900/2 plus
    // the 3100-wide, 0.00001-high triangular sliver.
    let hand = 3630.*900. - 530.*900./2. + 3100.*0.00001/2.;
    assert!((hand - 3028500.0155_f64).abs() < 1e-9);
    assert!((retrace::area(&points)-hand).abs() < 1e-9);
    let polygon = retrace::region(&points, 1e-12).unwrap();
    assert_eq!(polygon.len(), 4);
    assert!(!polygon.contains(&points[0]));
    let solid = Convex::extrusion(&polygon, [0.,0.,25632.]).unwrap();
    assert!((solid.volume() - hand*25632.).abs() < hand*25632.*1e-14);
    let mut near = points; near[0][1] = 0.001;
    assert!(retrace::region(&near, 1e-12).is_err());
}
fn box_(a: [f64;3], b: [f64;3]) -> Convex {
    Convex::extrusion(&[[a[0],a[1],a[2]],[b[0],a[1],a[2]],[b[0],b[1],a[2]],[a[0],b[1],a[2]]], [0.,0.,b[2]-a[2]]).unwrap()
}
#[test]
fn convex_inclusion_exclusion_and_oblique_prisms_have_hand_volumes() {
    let host = box_([0.;3],[2.;3]);
    let a = box_([0.;3],[1.,2.,2.]);
    let b = box_([0.;3],[2.,1.,2.]);
    let c = box_([0.;3],[2.,2.,1.]);
    // Three half boxes leave only [1,2]^3, including triple overlap.
    assert!((difference_volume(&host,&[a,b,c]).unwrap()-1.).abs() < 1e-12);
    assert!((difference_volume(&host,&[box_([3.;3],[4.;3])]).unwrap()-8.).abs()<1e-12);
    assert!((difference_volume(&host,std::slice::from_ref(&host)).unwrap()).abs()<1e-12);
    // Oblique unit-square prism: height is the normal component, 3.
    let oblique = Convex::extrusion(&[[0.,0.,0.],[1.,0.,0.],[1.,1.,0.],[0.,1.,0.]], [0.7,0.2,3.]).unwrap();
    assert!((oblique.volume()-3.).abs()<1e-12);
    assert!(Convex::extrusion(&[[0.,0.,0.],[2.,0.,0.],[0.5,0.5,0.],[2.,2.,0.],[0.,2.,0.]], [0.,0.,1.]).is_none());
}
#[test]
fn issue_3641_source_oracle_supports_all_arbitrarily_oriented_cutters() {
    let bytes = include_bytes!("../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(bytes, None);
    let mut decoder = ifc_lite_core::EntityDecoder::with_index(bytes, ifc_lite_core::build_entity_index(bytes));
    let origin = sources.extrusion_definitions.instances[&72209][0].world_from_source.unwrap();
    let origin = [origin[12],origin[13],origin[14]];
    let host = ifc_lite_retained_native::oracle::convex::source(&sources,72209,origin).unwrap();
    let a = ifc_lite_retained_native::oracle::convex::source(&sources,72216,origin).unwrap();
    let b = ifc_lite_retained_native::oracle::convex::source(&sources,72230,origin).unwrap();
    let c = retrace::source(&sources,&mut decoder,origin,1e-12).unwrap();
    assert!((c.volume()-3028500.0155*25632.*1e-9).abs()<1e-8);
    let remaining = difference_volume(&host,&[a,b,c]).unwrap();
    assert!(remaining>0. && remaining<host.volume());
    eprintln!("M8 independent slab oracle: {remaining:.15} m3");
}

#[test]
fn issue_3641_oracle_fails_closed_on_zero_or_multiple_omissions() {
    let multiple = [[0.,0.,0.],[2.,0.,0.],[2.,0.,0.],[2.,2.,0.],[0.,2.,0.]];
    assert_eq!(retrace::region(&multiple,1e-12), Err("oracle cannot model this profile"));
    let zero = [[0.,0.,0.],[2.,0.,0.],[3.,1.,0.],[2.,2.,0.],[0.,2.,0.]];
    assert_eq!(retrace::region(&zero,1e-12), Err("oracle cannot model this profile"));
}

#[test]
fn issue_3641_ordinary_quantity_sources_match_default_snapshot() {
    let bytes = include_bytes!("../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(bytes,None);
    let actual = serde_json::json!({"swept_disk_descriptions":sources.swept_disk_descriptions,
        "swept_disk_definitions":sources.swept_disk_definitions,"extrusion_definitions":sources.extrusion_definitions});
    if let Some(output) = std::env::var_os("IFCLITE_M8_QUANTITIES") {
        std::fs::write(output,serde_json::to_vec_pretty(&actual).unwrap()).unwrap();
        eprintln!("M8 quantity snapshot generation only; rerun without IFCLITE_M8_QUANTITIES to qualify");
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/m8-quantities.json");
    let expected: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(actual,expected);
}
