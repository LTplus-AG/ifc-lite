// SPDX-License-Identifier: MPL-2.0
use super::*;
use ifc_lite_core::{build_entity_index, EntityDecoder};
const FIXTURE: &[u8] = include_bytes!("../../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");

fn captured() -> RetainedProfileRegion {
    let mut decoder = EntityDecoder::with_index(FIXTURE, build_entity_index(FIXTURE));
    let solid = decoder.decode_by_id(61271).unwrap();
    with_source_capture(|| RetainedProfileRegion::capture(&solid, &mut decoder)).unwrap()
}

#[test]
fn issue_3641_original_fixture_region_result() {
    let region = captured();
    assert_eq!(region.raw_precision(), Some((0.2, 0.2)));
    assert_eq!(region.authored().solid_id, 61271);
    assert_eq!(region.authored().swept_area_id, Some(61272));
    assert!(matches!(region.authored().status, AnalyticStatus::Unsupported(_)));
    assert_eq!(region.boundary().segments.len(), 4, "REGION_RESULT");
    assert!((region.boundary().signed_area - 3_028_500.0155).abs() < 1e-8, "REGION_RESULT");
    assert_eq!(region.boundary().segments[0], AnalyticCurveSegment::Line {
        start: [870., 0., 0.], end: [1400., -900., 0.],
    }, "REGION_RESULT");
    let mut decoder = EntityDecoder::with_index(FIXTURE, build_entity_index(FIXTURE));
    let solid = decoder.decode_by_id(61271).unwrap();
    assert!(matches!(extract_analytic_extrusion(&solid, &mut decoder).status, AnalyticStatus::Unsupported(_)),
        "default simple-region contract stays conservative");
}

#[test]
fn issue_3641_original_edge_provenance() {
    let region = captured();
    let authored = &region.authored().profile.as_ref().unwrap().loops[0];
    assert_eq!(authored.segments.len(), 5, "REGION_PROVENANCE");
    assert_eq!(authored.source.as_ref().unwrap().root_entity_id, 61273);
    assert!(authored.source.as_ref().unwrap().records.contains_key(&61274));
    assert_eq!(region.edges().iter().map(|edge| edge.authored_edge).collect::<Vec<_>>(), [1,2,3,4], "REGION_PROVENANCE");
    assert_eq!(region.edges()[3].end, [870.,0.,0.], "REGION_PROVENANCE");
    assert_eq!(region.cancelled().authored_edges, [4,0], "REGION_PROVENANCE");
    assert_eq!(region.cancelled().from, [0.,0.,0.], "REGION_PROVENANCE");
    assert_eq!(region.cancelled().to, [870.,0.,0.], "REGION_PROVENANCE");
}

#[test]
fn issue_3641_region_work_guard_and_report() {
    let region = captured();
    let boundary = &region.authored().profile.as_ref().unwrap().loops[0];
    let error = regularize(boundary, 0.2, 1e-9, 0).unwrap_err();
    assert_eq!(error, "retained region work budget exceeded", "REGION_WORK_REPORT");
    assert!(regularize(boundary, 0.2, 1e-9, MAX_WORK).is_ok(), "REGION_WORK_GUARD");
}
