// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::analytic::{extract_analytic_extrusion, with_source_capture, AnalyticStatus};
use ifc_lite_core::{build_entity_index, EntityDecoder};
const FIXTURE: &str = include_str!("../../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
const POINTS: &str = "((0.,0.),(870.,0.),(1400.,-900.),(4500.,-900.00001),(4500.,0.))";

fn extrusion(text: &str, retained: bool) -> crate::analytic::AnalyticExtrusion {
    let mut decoder = EntityDecoder::with_index(text.as_bytes(), build_entity_index(text.as_bytes()));
    let solid = decoder.decode_by_id(61271).unwrap();
    if retained { super::super::try_extract_analytic_extrusion(&solid, &mut decoder).unwrap() }
    else { extract_analytic_extrusion(&solid, &mut decoder) }
}
fn altered(points: &str, indices: &str) -> String {
    FIXTURE.replace(POINTS, points).replace("IFCLINEINDEX((1,2,3,4,5,1))", &format!("IFCLINEINDEX(({indices}))"))
}

#[test]
fn issue_3641_seam_retrace_preserves_authored_source_and_exact_status() {
    let before = extrusion(FIXTURE, false);
    assert_eq!(before.status, AnalyticStatus::Unsupported("SweptArea #61272: loop 0, segments 0/4: profile boundaries touch, intersect, or cannot be separated at context Precision".into()));
    let result = with_source_capture(|| extrusion(FIXTURE, true));
    assert_eq!(result.status, AnalyticStatus::Complete);
    let boundary = &result.profile.as_ref().unwrap().loops[0];
    assert_eq!(boundary.segments.len(), 4);
    // Shoelace: (870*-900 + 1400*-900.00001 - (-900*4500)
    // + 4500*900.00001)/2 = 3028500.0155, not 3028499.5155.
    assert!((boundary.signed_area - 3028500.0155).abs() < 1e-6);
    assert!(matches!(boundary.segments[0], AnalyticCurveSegment::Line { start: [870., 0., 0.], .. }));
    let source = boundary.source.as_ref().unwrap();
    assert_eq!(source.root_entity_id, 61273);
    assert!(source.records.contains_key(&61274));
    let mut decoder = EntityDecoder::with_index(FIXTURE.as_bytes(), build_entity_index(FIXTURE.as_bytes()));
    let profile = decoder.decode_by_id(61272).unwrap();
    let original = with_source_capture(|| super::super::extract_analytic_profile(&profile, &mut decoder));
    assert!(matches!(original.status, AnalyticStatus::Unsupported(_)));
    // Retained admission cannot leak into exact or quantity extraction.
    assert_eq!(serde_json::to_value(extrusion(FIXTURE, false)).unwrap(), serde_json::to_value(before).unwrap());
}

#[test]
fn issue_3641_equal_retrace_and_two_spurs_cancel() {
    for (points, indices) in [
        ("((0.,0.),(4.,0.),(4.,4.),(2.,4.),(2.,6.),(2.,4.),(0.,4.))", "1,2,3,4,5,6,7,1"),
        ("((0.,0.),(4.,0.),(4.,4.),(2.,4.),(2.,6.),(2.,4.),(0.,4.),(-2.,4.),(0.,4.))", "1,2,3,4,5,6,7,8,9,1"),
    ] {
        let text = altered(points, indices);
        let result = extrusion(&text, true);
        assert_eq!(result.status, AnalyticStatus::Complete);
        assert_eq!(result.profile.unwrap().loops[0].signed_area, 16.);
    }
}

fn line_loop(points: &[[f64; 2]]) -> Vec<AnalyticCurveSegment> {
    (0..points.len()).map(|i| {
        let [sx, sy] = points[i]; let [ex, ey] = points[(i + 1) % points.len()];
        AnalyticCurveSegment::Line { start: [sx, sy, 0.], end: [ex, ey, 0.] }
    }).collect()
}

#[test]
fn issue_3641_straight_through_collinear_vertices_survive_a_retrace() {
    // (2,0) and the surviving (2,4) are exactly collinear with their neighbours
    // but lie between them (not an exact reversal): only the spur may cancel.
    let points = [[0.,0.],[2.,0.],[4.,0.],[4.,4.],[2.,4.],[2.,6.],[2.,4.],[0.,4.]];
    let segments = line_loop(&points);
    let mut live: Vec<usize> = (0..points.len()).collect();
    let mut cancelled = Vec::new();
    let residual = cancel_segments(&segments, |i| cancelled.push(live.remove(i))).unwrap().unwrap();
    assert_eq!(cancelled, [5, 6]);
    assert_eq!(residual, line_loop(&[[0.,0.],[2.,0.],[4.,0.],[4.,4.],[2.,4.],[0.,4.]]));
    // A loop whose only collinear vertex is straight-through has nothing to cancel.
    assert!(cancel_segments(&line_loop(&[[0.,0.],[2.,0.],[4.,0.],[4.,4.],[0.,4.]]), |_| {}).unwrap().is_none());
}

#[test]
fn issue_3641_near_collinear_and_v_reversals_are_not_cancelled() {
    for y in ["0.000000000001", "0.000000001", "0.0000001"] {
        let text = FIXTURE.replace("((0.,0.),(870.,0.),(1400.", &format!("((0.,{y}),(870.,0.),(1400."));
        let result = extrusion(&text, true);
        assert!(matches!(result.status, AnalyticStatus::Unsupported(ref s) if s.contains("retrace cancellation did not yield a valid region")), "{result:?}");
    }
}

#[test]
fn issue_3641_cancelled_spur_with_self_intersecting_residual_refuses() {
    let text = altered("((0.,0.),(-2.,0.),(0.,0.),(4.,4.),(0.,4.),(3.,0.))", "1,2,3,4,5,6,1");
    let result = extrusion(&text, true);
    assert!(matches!(result.status, AnalyticStatus::Unsupported(ref s) if s.ends_with("(retrace cancellation did not yield a valid region)")), "{result:?}");
}

#[test]
fn issue_3641_arcs_and_inner_loops_are_not_repaired() {
    let text = FIXTURE.replace("IFCLINEINDEX((1,2,3,4,5,1))", "IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4,5,1))");
    assert!(matches!(extrusion(&text, true).status, AnalyticStatus::Unsupported(_)));
    let text = FIXTURE.replace("IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'BL25632',#61273)", "IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,'BL25632',#61273,())");
    let result = extrusion(&text, true);
    assert!(matches!(result.status, AnalyticStatus::Unsupported(ref s) if !s.contains("retrace cancellation")));
}

#[test]
fn issue_3641_admission_restores_on_unwind_and_nested_call() {
    assert!(!admitted());
    let unwind = std::panic::catch_unwind(|| admitting(|| {
        admitting(|| assert!(admitted()));
        assert!(admitted());
        panic!("exercise unwind");
    }));
    assert!(unwind.is_err());
    assert!(!admitted());
}

#[test]
fn issue_3641_valid_profile_is_unchanged_and_predicates_charge_work() {
    let valid = FIXTURE.replace("IFCLINEINDEX((1,2,3,4,5,1))", "IFCLINEINDEX((2,3,4,5,2))");
    assert_eq!(serde_json::to_value(extrusion(&valid,true)).unwrap(), serde_json::to_value(extrusion(&valid,false)).unwrap());
    let original = extrusion(&valid,false).profile.unwrap().loops.remove(0);
    let budget = crate::resource::ProductBudget::new(crate::resource::BudgetStart::now(), 1, 1_000_000, 10000);
    budget.scope(|| assert!(matches!(cancel(&original),Err(WalkError::Stopped(_)))));
}
