// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M3-A source admission uses the real planner without acquiring a worker.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::admit_product;
const ISSUE: &[u8] = include_bytes!("fixtures/issue_2019_wall_two_overlapping_openings.ifc");
#[test]
fn issue_7955_opened_plain_extrusion_admits_host() {
    let source = SourceBundle::new(ISSUE.to_vec());
    let mut decoder = source.decoder();
    admit_product(source.clone(), &mut decoder, 30).unwrap();
}
#[test]
fn issue_7955_layered_opened_wall_refuses_before_worker() {
    let source = SourceBundle::new(include_bytes!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc").to_vec());
    let mut decoder = source.decoder();
    assert_eq!(admit_product(source.clone(), &mut decoder, 55).unwrap_err().refusal().code(), "material_layer_strategy");
    for id in [122, 188, 254] { admit_product(source.clone(), &mut decoder, id).unwrap(); }
}
