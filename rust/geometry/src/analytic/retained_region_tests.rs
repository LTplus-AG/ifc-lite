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

fn polygon(points: &[[f64;3]]) -> AnalyticProfileLoop {
    AnalyticProfileLoop { kind: ProfileLoopKind::Outer,
        segments: (0..points.len()).map(|i| AnalyticCurveSegment::Line {
            start: points[i], end: points[(i+1)%points.len()],
        }).collect(), signed_area: 1., perimeter: 1., source: None }
}
#[test]
fn issue_3641_region_negative_crossing_uncertainty_nonfinite_and_size() {
    let cases = [
        // Spur plus crossed surviving boundary.
        vec![[0.,0.,0.],[1.,0.,0.],[4.,-3.,0.],[2.,-3.,0.],[4.,0.,0.]],
        // The nominal retrace is not collinear; no tolerance-based snapping.
        vec![[0.,1e-12,0.],[1.,0.,0.],[2.,-1.,0.],[4.,-1.,0.],[4.,0.,0.]],
        // Unresolved thin region against the original raw Precision.
        vec![[0.,0.,0.],[1.,0.,0.],[2.,-0.01,0.],[4.,-0.01,0.],[4.,0.,0.]],
        vec![[0.,0.,0.],[1.,0.,0.],[2.,f64::NAN,0.],[4.,-1.,0.],[4.,0.,0.]],
    ];
    for points in cases {
        assert!(regularize(&polygon(&points),0.2,1e-9,MAX_WORK).is_err());
    }
    let points = vec![[0.,0.,0.]; MAX_EDGES+1];
    assert_eq!(regularize(&polygon(&points),0.2,1e-9,MAX_WORK).unwrap_err(), "retained region edge budget exceeded");
}

#[test]
fn issue_3641_region_work_guard() {
    let region = captured();
    let boundary = &region.authored().profile.as_ref().unwrap().loops[0];
    assert!(regularize(boundary,0.2,1e-9,0).is_err(), "REGION_WORK_GUARD");
}

#[test]
fn issue_3641_region_resource_refusal() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let region = captured();
    let boundary = &region.authored().profile.as_ref().unwrap().loops[0];
    for limits in [ResourceLimits {work:Some(0),..Default::default()},
        ResourceLimits {live_bytes:Some(0),..Default::default()},
        ResourceLimits {copy_bytes:Some(0),..Default::default()}] {
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(limits));
        assert!(account.scope(|| regularize(boundary,0.2,1e-9,MAX_WORK)).is_err());
    }
}

#[test]
fn issue_3641_region_units_rigid_frame_and_survey_translation_controls() {
    use crate::document::{capture_retained_extrusion, GeometryDocument, RetainedRecipe};
    for u in [1.,1000.] {
        let data = format!("#1=IFCCARTESIANPOINTLIST2D(((0.,0.),({},0.),({},{}),({},{}),({},0.)),$);
#2=IFCINDEXEDPOLYCURVE(#1,(IFCLINEINDEX((1,2,3,4,5,1))),$);
#3=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#2);
#4=IFCDIRECTION((0.,0.,-1.));#5=IFCEXTRUDEDAREASOLID(#3,#8,#4,{});
#6=IFCCARTESIANPOINT(({},{},{}));#7=IFCDIRECTION((0.,1.,0.));
#8=IFCAXIS2PLACEMENT3D(#6,$,#7);
#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,{},#8,$);",
            0.87*u,1.4*u,-0.9*u,4.5*u,-0.90000001*u,4.5*u,25.632*u,
            1e9*u,2e9*u,3e9*u,0.0002*u);
        let mut decoder = EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
        let solid = decoder.decode_by_id(5).unwrap();
        let RetainedRecipe::RegularizedExtrusion(recipe) = capture_retained_extrusion(&solid,&mut decoder,1./u).unwrap() else { panic!("expected distinct regularized recipe") };
        assert!((recipe.region.boundary().signed_area/u/u-3.0285000155).abs()<1e-12);
        let mut doc = GeometryDocument::new();
        let handle = doc.add_retained_region_extrusion(recipe).unwrap();
        let payload = doc.retained_payload(handle).unwrap();
        let frame = payload.source_from_evaluation;
        // Independent 90-degree rotation: raw (870,0) maps to (0,870).
        assert!((frame[12]/u-1e9).abs()<=1e-6);
        assert!((frame[13]/u-(2e9+0.87)).abs()<=1e-6);
        assert!((frame[14]/u-3e9).abs()<=1e-6);
        assert_eq!(payload.segments,4);
        let number = |at| f64::from_le_bytes(payload.bytes[at..at+8].try_into().unwrap());
        assert!((number(40)-25.632).abs()<1e-12);
        assert!((number(64+3*8)-0.53).abs()<1e-12);
    }
}

fn source_capture(data: &str) -> Result<RetainedProfileRegion, String> {
    let mut decoder = EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let solid = decoder.decode_by_id(61271).unwrap();
    with_source_capture(|| RetainedProfileRegion::capture(&solid, &mut decoder))
}

#[test]
fn issue_3641_authored_rounding_collision_refused() {
    let data = std::str::from_utf8(FIXTURE).unwrap().replace(
        "((0.,0.),(870.,0.),(1400.,-900.),(4500.,-900.00001),(4500.,0.))",
        "((0.,1.00000000000000001),(870.,1.),(1400.,-899.),(4500.,-899.00001),(4500.,1.))");
    assert!(source_capture(&data).is_err(), "REGION_DECIMAL_EQUALITY");
    assert!(source_capture(std::str::from_utf8(FIXTURE).unwrap()).is_ok());
}

#[test]
fn issue_3641_authored_underflow_refused() {
    let data = std::str::from_utf8(FIXTURE).unwrap().replace("((0.,0.),(870.,0.)", "((0.,1.E-400),(870.,0.)");
    assert!(source_capture(&data).is_err(), "REGION_DECIMAL_RANGE");
}

fn preflight_source(indices: &str) -> Result<(), String> {
    let data = std::str::from_utf8(FIXTURE).unwrap().replace("IFCLINEINDEX((1,2,3,4,5,1))", indices);
    let mut decoder = EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let solid = decoder.decode_by_id(61271).unwrap();
    preflight(&solid, &mut decoder)
}

#[test]
fn issue_3641_preflight_item_bound() {
    let indices = format!("{}IFCLINEINDEX((1,2,3,4,5,1))", "IFCLINEINDEX(()),".repeat(MAX_EDGES+1));
    assert_eq!(preflight_source(&indices).unwrap_err(), "retained region item budget exceeded", "REGION_PREFLIGHT_BOUND");
}

#[test]
fn issue_3641_preflight_cardinality() {
    assert_eq!(preflight_source("IFCLINEINDEX(()),IFCLINEINDEX((1,2,3,4,5,1))").unwrap_err(),
        "retained region invalid line index cardinality", "REGION_PREFLIGHT_CARDINALITY");
}

#[test]
fn issue_3641_preflight_charges_work() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { work: Some(0), ..Default::default() }));
    assert!(account.scope(|| preflight_source("IFCLINEINDEX((1,2,3,4,5,1))")).is_err(), "REGION_PREFLIGHT_CHARGE");
}

#[test]
fn issue_3641_profile_source_record() {
    let region = captured();
    let source = region.authored().source.as_ref().unwrap();
    assert!(source.records.contains_key(&61272), "REGION_PROFILE_RECORD");
    let record = &source.records[&61272];
    assert_eq!(record.id, 61272);
    assert_eq!(record.ifc_type_name, "IfcArbitraryClosedProfileDef");
    assert_eq!(record.attributes["ProfileType"], SourceValue::Enum("AREA".into()));
    assert_eq!(record.attributes["ProfileName"], SourceValue::String("BL25632".into()));
    assert_eq!(record.attributes["OuterCurve"], SourceValue::EntityRef(61273));
    assert_eq!(region.boundary().source.as_ref().unwrap().root_entity_id, 61273);
}
