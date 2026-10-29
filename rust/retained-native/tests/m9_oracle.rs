// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: hand-derived values qualify the source oracle without a kernel.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::canonical_type_maps;
use ifc_lite_retained_native::oracle::type_maps::expected;
#[path = "../../geometry/tests/support/m9_type_fixtures.rs"]
mod fixtures;
#[test]
fn issue_7955_m9_source_oracle_matches_hand_boxes_and_survey_rotation() {
    let fixture = include_str!("../../geometry/tests/fixtures/issue_6446_mapped_source_frames.ifc");
    let h = (3f64.sqrt() + 1.) / 4.; // projected half-width of a unit square rotated 30°
    for (text, id, parts, volume, bbox) in [
        (fixture.to_owned(), 105, 6, 6., [-0.5, -0.5, 0., 5_000_000.623456, 0.5, 1.]),
        (fixtures::SOURCE.to_owned(), 20, 1, 1., [-0.5, -0.5, 0., 0.5, 0.5, 1.]),
        (fixtures::rotated(), 20, 1, 1., [2_600_000.-h, 1_200_000.-h, 0., 2_600_000.+h, 1_200_000.+h, 1.]),
    ] {
        let source = SourceBundle::new(text.as_bytes().to_vec());
        let definitions = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
        let actual = expected(text.as_bytes(), &definitions, &canonical_type_maps(&source)[&id]).unwrap().unwrap();
        assert_eq!(actual.parts, parts);
        assert!((actual.volume-volume).abs() < 1e-12);
        for (a,b) in actual.bbox.unwrap().into_iter().zip(bbox) { assert!((a-b).abs() < 1e-9, "{a} vs {b}"); }
    }
}
