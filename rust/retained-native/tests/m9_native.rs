// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M9: real SDK, atomic outcomes, authored frame and independent quantities.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::{block_on, NativeDomain, NativeReceipt, NativeWorker};
use std::{cell::Cell, rc::Rc};
#[path = "../../geometry/tests/support/m9_type_fixtures.rs"]
mod fixtures;
#[allow(dead_code)] // Measurement helper shared with the comparison harness.
#[path = "../examples/compare/metrics.rs"]
mod metrics;
const MIXED: &str = include_str!("../../geometry/tests/fixtures/issue_6446_mapped_source_frames.ifc");
const TESSELLATED: &str = include_str!("../../geometry/tests/fixtures/issue_4560_wall_roof_polygonal_cutters.ifc");
struct Observed { worker: NativeWorker, calls: Rc<Cell<usize>> }
impl RetainedRuntime for Observed {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain { self.worker.domain() }
    fn incarnation(&self) -> u64 { self.worker.incarnation() }
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self, call: Invocation<'_, NativeReceipt>, limits: NumericalLimits) -> Result<NativeReceipt, RuntimeFault> {
        self.calls.set(self.calls.get()+1);
        self.worker.invoke(call, limits).await
    }
}
fn run(text: &str, ids: &[u32]) -> Option<(Vec<ProductOutcome>, usize)> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib required");
        eprintln!("SKIP M9 native: set IFCLITE_SMLIB_WORKER; not SDK evidence");
        return None;
    };
    let calls = Rc::new(Cell::new(0));
    let mut outcomes = Vec::new();
    block_on(run_model(SourceBundle::new(text.as_bytes().to_vec()),
        &ModelOptions { ids: Some(ids.iter().copied().collect()), ..Default::default() },
        || NativeWorker::spawn(&path).map(|worker| Observed { worker, calls: calls.clone() }),
        |outcome| outcomes.push(outcome))).unwrap();
    Some((outcomes, calls.get()))
}
fn shape(outcomes: &[ProductOutcome], id: u32) -> &ShapeOnlyProduct {
    outcomes.iter().find_map(|o| match o { ProductOutcome::Published(s) if s.product_id == id => Some(s), _ => None })
        .unwrap_or_else(|| panic!("#{id} not published: {outcomes:?}"))
}
fn measure(shape: &ShapeOnlyProduct) -> metrics::Metrics {
    let mut result = metrics::Metrics::default();
    for part in &shape.parts {
        let points: Vec<_> = part.positions.chunks_exact(3).map(|p|
            metrics::transform(&part.world_from_object, [p[0], p[1], p[2]])).collect();
        result.add_mesh(&points, &part.indices).unwrap();
    }
    result
}
fn check(shape: &ShapeOnlyProduct, parts: usize, volume: f64, bbox: [f64; 6]) {
    let actual = measure(shape);
    assert_eq!(shape.parts.len(), parts);
    assert_eq!(actual.defects, 0);
    assert!(metrics::relative(actual.volume, volume) <= 1e-6, "{} vs {volume}", actual.volume);
    assert!(metrics::bbox_deviation(&actual.bbox, &bbox) <= 1e-5);
    assert_eq!(shape.obligations.0, []);
}
#[test]
fn issue_7955_m9_native_mixed_frames_and_survey_origin() {
    let Some((outcomes, calls)) = run(MIXED, &[105]) else { return; };
    assert_eq!(outcomes.len(), 1);
    assert!(calls > 0);
    check(shape(&outcomes, 105), 6, 6., [-0.5,-0.5,0.,5_000_000.623456,0.5,1.]);
    let (outcomes, _) = run(&fixtures::rotated(), &[20]).unwrap();
    let h = (3f64.sqrt()+1.)/4.;
    check(shape(&outcomes, 20), 1, 1., [2_600_000.-h,1_200_000.-h,0.,2_600_000.+h,1_200_000.+h,1.]);
    println!("sdk witness executed: m9_frames");
}
#[test]
fn issue_7955_m9_native_boolean_map_composes() {
    let Some((outcomes, _)) = run(&fixtures::boolean(), &[20]) else { return; };
    check(shape(&outcomes, 20), 1, 1.5, [-0.5,-0.5,0.,1.,0.5,1.]);
    println!("sdk witness executed: m9_boolean");
}
#[test]
fn issue_7955_m9_native_refusals_are_atomic() {
    for (text, expected, zero_calls) in [(fixtures::mirrored(), "incomplete", true),
        (fixtures::unsupported_second(), "operation_unsupported", false)] {
        let Some((outcomes, calls)) = run(&text, &[20]) else { return; };
        assert_eq!(outcomes.len(), 1);
        assert!(matches!(&outcomes[0], ProductOutcome::Refused { product_id: 20, refusal, .. } if refusal.code() == expected), "{outcomes:?}");
        if zero_calls { assert_eq!(calls, 0); }
    }
    println!("sdk witness executed: m9_atomic_refusals");
}
#[test]
fn issue_7955_m9_native_curve_only_and_instanced_types_are_absent() {
    for text in [fixtures::curves(), fixtures::instanced()] {
        assert!(ifc_lite_processing::process_geometry(text.as_bytes()).meshes.is_empty());
        let Some((outcomes, calls)) = run(&text, &[20]) else { return; };
        assert!(outcomes.is_empty());
        assert_eq!(calls, 0);
    }
    println!("sdk witness executed: m9_absent_types");
}
#[test]
fn issue_7955_m9_stage_native_browser_reference() {
    let Some((mixed, _)) = run(MIXED, &[105]) else { return; };
    let (tessellated, _) = run(TESSELLATED, &[360,456,1215]).unwrap();
    assert_eq!(mixed.len(), 1);
    assert_eq!(tessellated.len(), 3);
    for outcome in &tessellated {
        assert!(matches!(outcome, ProductOutcome::Refused { refusal, .. } if refusal.code() == "operation_unsupported"));
    }
    let rows = |outcomes: &[ProductOutcome]| outcomes.iter().map(|o| match o {
        ProductOutcome::Published(s) => serde_json::json!({"id":s.product_id,"code":"published","volume":measure(s).volume}),
        ProductOutcome::Refused { product_id, refusal, .. } => serde_json::json!({"id":product_id,"code":refusal.code()}),
    }).collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("IFCLITE_M9_REFERENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({"mixed":rows(&mixed),"tessellated":rows(&tessellated)})).unwrap()).unwrap();
    }
    println!("sdk witness executed: m9_reference");
}
