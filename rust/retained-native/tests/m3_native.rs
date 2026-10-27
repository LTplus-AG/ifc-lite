// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M3-A real SMLib witnesses. Missing SDK is explicitly not evidence.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::{block_on, run_model_native, NativeDomain, NativeReceipt, NativeWorker};
use ifc_lite_retained_native::oracle::openings;
use std::{cell::{Cell, RefCell}, rc::Rc};
#[path = "../../geometry/tests/support/m3_opening_fixtures.rs"]
mod fixtures;
#[allow(dead_code)] // Shared test/harness measurement helper; each consumer uses different comparisons.
#[path = "../examples/compare/metrics.rs"]
mod metrics;
#[allow(dead_code)] // Shared exact storage-frame measurement, also exercised by the harness.
#[path = "../examples/compare/precision.rs"]
mod precision;
const ISSUE: &str = include_str!("../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
const FD: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-d-openings.ifc");
fn nonbakeable_source() -> String {
    FD.replace("OPERATOR3D($,$,#1,2.,$)", "OPERATOR3DNONUNIFORM($,$,#1,1.E200,$,1.E200,1.)")
}
fn worker() -> Option<std::ffi::OsString> {
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib SDK required");
        eprintln!("SKIP M3 native: set IFCLITE_SMLIB_WORKER; not SDK evidence");
    }
    path
}
fn run(text: &str, ids: &[u32]) -> Option<Vec<ProductOutcome>> {
    let path = worker()?;
    let mut outcomes = Vec::new();
    run_model_native(SourceBundle::new(text.as_bytes().to_vec()), path,
        &ModelOptions { ids: Some(ids.iter().copied().collect()), ..Default::default() },
        |o| outcomes.push(o)).unwrap();
    Some(outcomes)
}
fn shape(outcomes: &[ProductOutcome], id: u32) -> &ShapeOnlyProduct {
    outcomes.iter().find_map(|o| match o {
        ProductOutcome::Published(s) if s.product_id == id => Some(s), _ => None,
    }).unwrap_or_else(|| panic!("missing published #{id}: {outcomes:?}"))
}
fn refusal(outcomes: &[ProductOutcome], id: u32) -> (&str, Option<RefusalOrigin>) {
    outcomes.iter().find_map(|o| match o {
        ProductOutcome::Refused { product_id, refusal, origin, .. } if *product_id == id => Some((refusal.code(), *origin)),
        _ => None,
    }).unwrap_or_else(|| panic!("missing refused #{id}: {outcomes:?}"))
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
fn oracle(text: &str, outcomes: &[ProductOutcome], host: u32, cutters: &[u32]) {
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let expected = openings::expected(&sources, host, cutters).expect("independent source quantities");
    let actual = measure(shape(outcomes, host));
    let tolerances: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.json")).unwrap();
    let key = if expected.curved { "curved" } else { "linear" };
    // Every fixture passed here is in the parallel right-prism family,
    // including mapped/scaled cutters; None must never downgrade to bounds.
    assert!(expected.result_volume.is_some(), "#{host}: required prism oracle must execute");
    if host == 149 {
        assert_eq!(expected.result_volume, Some(expected.nominal_host_volume),
            "the non-intersecting opening must preserve the uncut volume exactly");
    }
    if let Some(volume) = expected.result_volume {
        let relative = metrics::relative(actual.volume, volume);
        assert!(relative <= tolerances["openingPrismVolumeRelative"][key].as_f64().unwrap(), "#{host} volume {} vs {volume}, relative {relative}", actual.volume);
    }
    let bounds = openings::volume_bounds_relative(actual.volume, expected.volume_bounds);
    assert!(bounds <= tolerances["openingVolumeBoundsRelative"][key].as_f64().unwrap(), "#{host} volume {} outside {:?}", actual.volume, expected.volume_bounds);
    if let Some(bbox) = expected.host_bbox {
        let extent = (0..3).map(|i| bbox[i + 3] - bbox[i]).fold(0., f64::max);
        let limit = tolerances["openingResultBboxWithinHost"]["absolute"].as_f64().unwrap()
            + extent * tolerances["openingResultBboxWithinHost"]["extentFactor"].as_f64().unwrap();
        assert!(openings::bbox_excess(&actual.bbox, &bbox) <= limit, "#{host} source bbox");
    }
    assert_eq!(actual.defects, 0, "#{host} must be closed");
    println!("source oracle: {}", serde_json::json!({"id":host,"volume":actual.volume,
        "prism":expected.result_volume,"bounds":expected.volume_bounds,"bbox":expected.host_bbox,
        "closureDefects":actual.defects}));
}
#[test]
fn issue_7955_m3_prism_and_curved_opening_witnesses() {
    let Some(outcomes) = run(ISSUE, &[30, 50, 70, 100]) else { return; };
    oracle(ISSUE, &outcomes, 30, &[50, 70, 100]);
    assert_eq!(shape(&outcomes, 30).cuts, 3);
    assert_eq!(shape(&outcomes, 30).cut_times_ms.len(), 3);
    let curved = include_str!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
    let outcomes = run(curved, &[122, 188, 254]).unwrap();
    for (host, opening) in [(122, 129), (188, 195), (254, 261)] { oracle(curved, &outcomes, host, &[opening]); }
    println!("sdk witness executed: m3_prism_curved");
}
#[test]
fn issue_7955_m3_synthetic_cases_and_empty_refusals() {
    // M3-0 labels f-d UNREVIEWED. Exercise its cases, but do not add it to
    // coverage or claim third-party fixture qualification from these tests.
    let Some(outcomes) = run(FD, &[29, 55, 73, 107, 128, 149, 167, 185, 203, 225, 248]) else { return; };
    for (host, cutters) in [(29, vec![40]), (55, vec![62]), (73, vec![88]), (149, vec![156]), (167, vec![]), (185, vec![192]), (225, vec![232])] {
        oracle(FD, &outcomes, host, &cutters);
    }
    for id in [107, 128] {
        let (code, origin) = refusal(&outcomes, id);
        assert_eq!(code, "empty_result");
        assert_eq!(origin.unwrap().site, "opening_cut");
        assert_eq!(origin.unwrap().cause, "consumed");
        assert!(outcomes.iter().any(|o| matches!(o, ProductOutcome::Refused {
            product_id, cut_times_ms, ..
        } if *product_id == id && cut_times_ms.len() == 1 && cut_times_ms[0].is_finite())));
    }
    // Round-3 ruling: Axis/SweptSolid follows exact's type-first body rule;
    // a single material layer has no internal boundaries. Neither is a refusal.
    assert_eq!(shape(&outcomes, 185).cuts, 1);
    assert_eq!(shape(&outcomes, 225).cuts, 1);
    let (layered, calls, _) = observed(FD, &[248], None).unwrap();
    assert_eq!(refusal(&layered, 248).0, "material_layer_strategy");
    assert_eq!(calls, 0, "two-layer host must refuse before opening cuts");
    report_exact(FD, &outcomes, &[29, 185]);
    println!("sdk witness executed: m3_synthetic_empty");
}
// #7955 exact is report-only: reuse its storage frame and the M1 f32 rounding.
fn report_exact(text: &str, outcomes: &[ProductOutcome], ids: &[u32]) {
    let exact = ifc_lite_processing::process_geometry(text.as_bytes());
    let mut rows = Vec::new();
    for &id in ids {
        let mut actual = metrics::Metrics::default();
        let mut origins = Vec::new();
        for mesh in exact.meshes.iter().filter(|m| m.express_id == id) {
            origins.push(mesh.origin);
            let points: Vec<_> = mesh.positions.chunks_exact(3).map(|p|
                exact.frame.to_world(std::array::from_fn(|i| mesh.origin[i] + p[i] as f64))).collect();
            actual.add_mesh(&points, &mesh.indices).unwrap();
        }
        let retained = precision::measure(shape(outcomes, id), exact.frame, &origins).unwrap();
        rows.push(serde_json::json!({"id":id,"exactVolume":actual.volume,
            "retainedStorageVolume":retained.volume,"retainedF64Volume":measure(shape(outcomes,id)).volume,
            "relative":metrics::relative(retained.volume, actual.volume),"reportOnly":true}));
    }
    println!("exact comparison: {}", serde_json::json!(rows));
    if let Some(path) = std::env::var_os("IFCLITE_M3_EXACT_REFERENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    }
}
struct ObservedWorker {
    inner: NativeWorker, booleans: Rc<Cell<usize>>, fail: Option<usize>,
    faults: Rc<RefCell<Vec<(usize, String)>>>,
}
impl RetainedRuntime for ObservedWorker {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain { self.inner.domain() }
    fn incarnation(&self) -> u64 { self.inner.incarnation() }
}
impl AsyncRetainedExecutor for ObservedWorker {
    async fn invoke(&mut self, call: Invocation<'_, NativeReceipt>, limits: NumericalLimits) -> Result<NativeReceipt, RuntimeFault> {
        if matches!(call, Invocation::Boolean { .. }) {
            self.booleans.set(self.booleans.get() + 1);
            if self.fail == Some(self.booleans.get()) { return Err(RuntimeFault::kernel(7, "M3 injected Boolean failure")); }
        }
        let result = self.inner.invoke(call, limits).await;
        if let Err(error) = &result {
            self.faults.borrow_mut().push((self.booleans.get(), error.to_string()));
        }
        result
    }
}
type Observation = (Vec<ProductOutcome>, usize, Vec<(usize, String)>);
fn observed(text: &str, ids: &[u32], fail: Option<usize>) -> Option<Observation> {
    let path = worker()?;
    let booleans = Rc::new(Cell::new(0));
    let faults = Rc::new(RefCell::new(Vec::new()));
    let mut outcomes = Vec::new();
    block_on(run_model(SourceBundle::new(text.as_bytes().to_vec()),
        &ModelOptions { ids: Some(ids.iter().copied().collect()), ..Default::default() },
        || NativeWorker::spawn(&path).map(|inner| ObservedWorker { inner, booleans: booleans.clone(), fail, faults: faults.clone() }),
        |o| outcomes.push(o))).unwrap();
    Some((outcomes, booleans.get(), faults.take()))
}
#[test]
fn issue_7955_m3_scaled_cutter_uses_m1_admission_and_source_oracle() {
    // Round-2 ruling: M1 bakes #210 before cutting. Do not add a scale refusal.
    let Some((outcomes, calls, _)) = observed(FD, &[203], None) else { return; };
    assert_eq!(calls, 1, "the baked cutter must reach the real Difference once");
    assert_eq!(outcomes.len(), 1, "one atomic outcome, no partial publication");
    oracle(FD, &outcomes, 203, &[214]);
    assert_eq!(shape(&outcomes, 203).cuts, 1);
    println!("sdk witness executed: m3_scaled_cutter");
}
#[test]
fn issue_7955_m3_nonbakeable_cutter_preserves_m1_refusal() {
    let Some((outcomes, calls, _)) = observed(&nonbakeable_source(), &[203, 214], None) else { return; };
    assert_eq!(calls, 0, "M1 refuses this mapping before a Difference");
    assert_eq!(outcomes.len(), 2);
    for id in [203, 214] {
        let (code, origin) = refusal(&outcomes, id);
        assert_eq!(code, "source_invalid");
        assert_eq!(origin.unwrap().entity, Some(211));
        assert_eq!(origin.unwrap().site, "mapping_placement");
    }
    println!("sdk witness executed: m3_nonbakeable_cutter");
}
#[test]
fn issue_7955_m3_unsupported_opening_never_invokes_boolean() {
    let text = include_str!("../../geometry/tests/fixtures/issue_098_wall_W.ifc");
    let Some((outcomes, calls, _)) = observed(text, &[928204], None) else { return; };
    let (code, origin) = refusal(&outcomes, 928204);
    assert_eq!(code, "opening_unsupported");
    assert_eq!(origin.unwrap().entity, Some(1952583));
    assert_eq!(calls, 0);
    println!("sdk witness executed: m3_unsupported");
}
#[test]
fn issue_7955_m3_kernel_failure_is_atomic_and_next_product_succeeds() {
    let Some((outcomes, calls, _)) = observed(ISSUE, &[30, 50], Some(2)) else { return; };
    assert_eq!(calls, 2);
    assert!(matches!(&outcomes[0], ProductOutcome::Refused {
        refusal: RetainedProductRefusal::KernelFailure { status: 7 }, cut_times_ms, ..
    } if cut_times_ms.len() == 2 && cut_times_ms.iter().all(|ms| ms.is_finite() && *ms >= 0.)));
    assert_eq!(shape(&outcomes, 50).cuts, 0);
    println!("sdk witness executed: m3_kernel_failure");
}
#[test]
fn issue_7955_m3_survey_rotation_preserves_oracle_volume() {
    let text = ISSUE.replace("#8= IFCLOCALPLACEMENT($,#5);", "#301=IFCCARTESIANPOINT((100000.,200000.,0.));\n#302=IFCDIRECTION((0.8660254037844386,0.5,0.));\n#303=IFCAXIS2PLACEMENT3D(#301,#4,#302);\n#8=IFCLOCALPLACEMENT($,#303);");
    let Some(outcomes) = run(&text, &[30]) else { return; };
    oracle(&text, &outcomes, 30, &[50, 70, 100]);
    let original = run(ISSUE, &[30]).unwrap();
    assert!(metrics::relative(measure(shape(&outcomes, 30)).volume, measure(shape(&original, 30)).volume) <= 1e-6);
    println!("sdk witness executed: m3_frames");
}
#[test]
fn issue_7955_m3_lineage_limit_refuses_whole_product() {
    let mut text = ISSUE.lines().filter(|line| !["#80=", "#81=", "#82="].iter().any(|p| line.starts_with(p))).collect::<Vec<_>>().join("\n");
    let mut records = String::new();
    for i in 0..130 {
        records.push_str(&format!("#{}=IFCOPENINGELEMENT('o{i}',$,$,$,$,#49,#48,$);\n#{}=IFCRELVOIDSELEMENT('v{i}',$,$,$,#30,#{});\n", 500+i, 700+i, 500+i));
    }
    text = text.replace("ENDSEC;\nEND-ISO", &format!("{records}ENDSEC;\nEND-ISO"));
    let Some((outcomes, calls, faults)) = observed(&text, &[30], None) else { return; };
    assert_eq!(refusal(&outcomes, 30).0, "resource_exhausted");
    // ProductOutcome does not expose a RuntimeFault origin. Observe the real
    // worker's diagnostic before classification, and prove the 128-op boundary.
    assert_eq!(calls, 129, "128 cuts succeed; the next exceeds the lineage limit");
    assert_eq!(faults, [(129, "geometry worker resource limit: retained dependency depth".into())]);
    println!("sdk witness executed: m3_lineage");
}
#[test]
fn issue_7955_m3_stage_native_browser_reference() {
    let Some(issue) = run(ISSUE, &[30, 50, 70, 100]) else { return; };
    let synthetic = run(FD, &[29, 55, 73, 107, 128, 149, 167, 185, 203, 225, 248]).unwrap();
    let nonbakeable = run(&nonbakeable_source(), &[203, 214]).unwrap();
    let rows = |outcomes: &[ProductOutcome]| outcomes.iter().map(|o| match o {
        ProductOutcome::Published(s) => serde_json::json!({"id":s.product_id,"code":"published","volume":measure(s).volume}),
        ProductOutcome::Refused { product_id, refusal, .. } => serde_json::json!({"id":product_id,"code":refusal.code()}),
    }).collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("IFCLITE_M3_REFERENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({"issue2019":rows(&issue),"synthetic":rows(&synthetic),"nonbakeable":rows(&nonbakeable)})).unwrap()).unwrap();
    }
    println!("sdk witness executed: m3_reference");
}

#[test]
fn issue_7955_m3_two_parts_receive_both_openings() {
    let text = fixtures::two_parts_two_openings();
    let Some(outcomes) = run(&text, &[30]) else { return; };
    // The aggregate source oracle rejects an uncut later part (1.6 vs 1.28 m³).
    oracle(&text, &outcomes, 30, &[50, 70]);
    let product = shape(&outcomes, 30);
    assert_eq!(product.parts.len(), 2);
    assert_eq!(product.cuts, 4);
    assert_eq!(product.cut_times_ms.len(), 4);
    println!("sdk witness executed: m3_two_parts_two_openings");
}

#[test]
fn issue_7955_m3_opening_without_body_values_is_source_invalid() {
    // Representation=$ is a valid absent body, so its logical walk succeeds
    // with zero values; the executor must reject it before issuing any cuts.
    let text = ISSUE.replace("#49,#48,$)", "#49,$,$)");
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = ifc_lite_geometry::GeometryRouter::with_units(&text, &mut decoder);
    assert!(router.opening_requires_subtraction(50, &mut decoder));
    let entity = decoder.decode_by_id(50).unwrap();
    let mut body = ifc_lite_geometry::program::transactions::Traversal::new(1, 1).opening_body(&entity);
    while let Some(ticket) = body.request().unwrap() {
        let (reply, operations, _storage) = body.admit(ticket, &router, &mut decoder).unwrap();
        assert!(operations.is_empty(), "absent body needs no kernel work");
        body.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(body.finish().unwrap().values().len(), 0);
    let Some((outcomes, calls, _)) = observed(&text, &[30], None) else { return; };
    assert_eq!(outcomes.len(), 1);
    assert_eq!(refusal(&outcomes, 30).0, "source_invalid");
    assert_eq!(calls, 0, "no cuts or partial product from an absent opening body");
    println!("sdk witness executed: m3_empty_opening_body");
}
