// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M7: real SDK only; source expectations never come from measured meshes.
#[path = "support/geometry_assertions.rs"]
#[allow(dead_code)]
mod geometry_assertions;
#[path = "../examples/compare/metrics.rs"]
#[allow(dead_code)]
mod metrics;
mod support;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::{
    block_on,
    oracle::{mapped, openings::bbox_excess},
    NativeDomain, NativeReceipt, NativeWorker,
};
use std::{cell::Cell, rc::Rc};
use support::{native, refusal, shape, worker_path};
const SOURCE: &str =
    include_str!("../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans.ifc");
const ADVERSARIAL: &str =
    include_str!("../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans-adversarial.ifc");
const POSITIVE: [(u32, f64); 10] = [
    (38, 5.25),
    (46, 5.25),
    (54, 5.25),
    (65, 5.25),
    (78, 10.5),
    (96, 9.),
    (107, 3.),
    (181, 5.25 - 0.064),
    (190, 0.064),
    (219, 6. - 0.12 * std::f64::consts::PI),
];
fn tolerances() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/cli-retained/tolerances.d/m7.json"
    ))
    .unwrap()
}

// The source oracle must independently reproduce hand arithmetic before it is
// compared with a kernel. B=2*1*3=6; H intersection B=.5*.5*3=.75.
// Union=6+6-1*1*3=9; intersection=3; half-scale H=.25*.25*2=.125.
// Opening=.4³=.064; circular through-cut=pi*.2²*3=.12*pi.
// e13's opening is [.1,.5]x[.3,.7]x[0,.4], wholly inside B and
// disjoint from H (whose x starts at .75): net=5.25-.064=5.186.
// The mapped oracle evaluates the body; compose its independent opening volume
// here rather than asking it to interpret relationships outside its contract.
fn expectation(id: u32) -> mapped::MappedExpectation {
    let mut expected = mapped::expected(SOURCE.as_bytes(), id).unwrap();
    if id == 181 {
        expected.volume -= mapped::expected(SOURCE.as_bytes(), 190).unwrap().volume;
    }
    expected
}
#[test]
fn m7_source_oracle_matches_hand_arithmetic() {
    for (id, hand) in POSITIVE {
        let expectation = expectation(id);
        assert!(
            (expectation.volume - hand).abs() < 1e-12,
            "#{id}: {expectation:?} != {hand}"
        );
    }
    assert_eq!(mapped::expected(SOURCE.as_bytes(), 202).unwrap().volume, 0.);
    for id in [156, 173, 231] {
        assert!(mapped::expected(SOURCE.as_bytes(), id).is_none());
    }
    assert_eq!(
        mapped::expected(SOURCE.as_bytes(), 65).unwrap().bbox,
        [2600000., 1200000., 400., 2600002., 1200001., 403.]
    );
}

#[test]
fn m7_sdk_oracle_closed_shapes() {
    let Some(outcomes) = native(SOURCE) else {
        return;
    };
    let tolerance = tolerances();
    let mut reference = Vec::new();
    for (id, _) in POSITIVE {
        let expected = expectation(id);
        let product = shape(&outcomes, id);
        let actual = geometry_assertions::measured(product);
        let relative = tolerance["mappedBooleanVolumeRelative"]
            [if expected.curved { "curved" } else { "linear" }]
        .as_f64()
        .unwrap();
        assert!(
            metrics::relative(actual.volume, expected.volume) <= relative,
            "#{id}: {actual:?} != {expected:?}"
        );
        let bbox = &tolerance["mappedBooleanBboxWithinLeftOperand"];
        let extent = (0..3)
            .map(|i| expected.bbox[i + 3] - expected.bbox[i])
            .fold(0., f64::max);
        assert!(
            bbox_excess(&actual.bbox, &expected.bbox)
                <= bbox["absolute"].as_f64().unwrap()
                    + extent * bbox["extentFactor"].as_f64().unwrap()
        );
        assert_eq!(actual.defects, 0, "#{id} exact coordinate edge keys");
        assert_eq!(product.parts.len(), expected.parts);
        reference
            .push(serde_json::json!({"expressId":id,"code":"published","volume":actual.volume}));
    }
    for (id, code) in [
        (133, "incomplete"),
        (141, "incomplete"),
        (156, "operation_unsupported"),
        (173, "operation_unsupported"),
        (202, "empty_result"),
        (231, "operation_unsupported"),
    ] {
        assert_eq!(refusal(&outcomes, id).code(), code, "#{id}");
        reference.push(serde_json::json!({"expressId":id,"code":code}));
    }
    assert_eq!(outcomes.len(), 16);
    // Non-schema inputs are explicitly outside coverage qualification. Pin only
    // controller outcomes and parity, never include them in published deltas.
    let adversarial = native(ADVERSARIAL).unwrap();
    assert_eq!(adversarial.len(), 2);
    assert_eq!(refusal(&adversarial, 242).code(), "source_invalid");
    let value = geometry_assertions::measured(shape(&adversarial, 125));
    reference.push(serde_json::json!({"fixture":"adversarial", "expressId":125, "code":"published", "volume":value.volume}));
    reference.push(
        serde_json::json!({"fixture":"adversarial", "expressId":242, "code":"source_invalid"}),
    );
    // The existing CI native step precedes browser compilation. Stage a small
    // ignored reference next to the browser crate without touching /smlib,
    // whose asset staging deliberately refuses an existing output directory.
    let staged = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../wasm-bindings/m7-native-reference.output.json");
    std::fs::write(staged, serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    if let Some(path) = std::env::var_os("IFCLITE_M7_NATIVE_REFERENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    }
    eprintln!("sdk witness executed: m7_sdk_oracle_closed_shapes");
}

#[test]
fn m7_sdk_placement_and_inline_equivalence() {
    let Some(outcomes) = native(SOURCE) else {
        return;
    };
    let base = geometry_assertions::measured(shape(&outcomes, 38)).volume;
    let tolerance = tolerances()["mappedPlacementEquivalenceRelative"]
        .as_f64()
        .unwrap();
    for id in [46, 54, 65] {
        assert!(
            metrics::relative(
                geometry_assertions::measured(shape(&outcomes, id)).volume,
                base
            ) <= tolerance
        );
    }
    // Replace only e1's body item with M1's identical Boolean tree (#28),
    // keeping its product placement. This is a direct source twin, not a mock.
    let inline = SOURCE.replace(
        "#36=IFCSHAPEREPRESENTATION(#4,'Body','MappedRepresentation',(#35));",
        "#36=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#28));",
    );
    assert_ne!(inline, SOURCE);
    let direct = native(&inline).unwrap();
    assert!(
        metrics::relative(
            geometry_assertions::measured(shape(&direct, 38)).volume,
            base
        ) <= tolerance
    );
    eprintln!("sdk witness executed: m7_sdk_placement_and_inline_equivalence");
}

#[derive(Default)]
struct Counts {
    calls: Cell<usize>,
    booleans: Cell<usize>,
    empty: Cell<usize>,
    boolean_ms: Cell<f64>,
}
struct Counting {
    worker: NativeWorker,
    counts: Rc<Counts>,
}
impl RetainedRuntime for Counting {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain {
        self.worker.domain()
    }
    fn incarnation(&self) -> u64 {
        self.worker.incarnation()
    }
}
impl AsyncRetainedExecutor for Counting {
    async fn invoke(
        &mut self,
        call: Invocation<'_, NativeReceipt>,
        limits: NumericalLimits,
    ) -> Result<NativeReceipt, RuntimeFault> {
        self.counts.calls.set(self.counts.calls.get() + 1);
        let boolean = matches!(call, Invocation::Boolean { .. });
        let start = std::time::Instant::now();
        let receipt = self.worker.invoke(call, limits).await?;
        if boolean {
            self.counts.booleans.set(self.counts.booleans.get() + 1);
            self.counts
                .boolean_ms
                .set(self.counts.boolean_ms.get() + start.elapsed().as_secs_f64() * 1000.);
        }
        // NativeReceipt exposes only authenticated opcode-19 Boolean evidence;
        // the wrapper cannot invent or change it, and forwards it unchanged.
        if matches!(
            receipt.evidence(),
            ReceiptEvidence::Boolean { empty: true, .. }
        ) {
            receipt.validate_live()?;
            self.counts.empty.set(self.counts.empty.get() + 1);
        }
        Ok(receipt)
    }
}
fn counted(id: u32) -> Option<(Vec<ProductOutcome>, Rc<Counts>)> {
    let path = worker_path()?;
    let counts = Rc::new(Counts::default());
    let mut outcomes = Vec::new();
    block_on(run_model(
        SourceBundle::new(SOURCE.as_bytes().to_vec()),
        &ModelOptions {
            ids: Some([id].into_iter().collect()),
            ..Default::default()
        },
        || {
            Ok(Counting {
                worker: NativeWorker::spawn(&path)?,
                counts: counts.clone(),
            })
        },
        |o| outcomes.push(o),
    ))
    .unwrap();
    Some((outcomes, counts))
}
#[test]
fn m7_sdk_e5_one_boolean_two_parts() {
    let Some((outcomes, counts)) = counted(78) else {
        return;
    };
    assert_eq!(shape(&outcomes, 78).parts.len(), 2);
    assert_eq!(counts.booleans.get(), 1);
    assert_eq!(counts.calls.get(), 3);
    eprintln!(
        "M7 e5: booleanCount=1 booleanMs={}",
        counts.boolean_ms.get()
    );
    eprintln!("sdk witness executed: m7_sdk_e5_one_boolean_two_parts");
}
#[test]
fn m7_sdk_affine_boundary_and_authenticated_empty() {
    if worker_path().is_none() {
        return;
    }
    for id in [133, 141] {
        let (outcomes, counts) = counted(id).unwrap();
        assert_eq!(refusal(&outcomes, id).code(), "incomplete");
        assert_eq!(counts.calls.get(), 0);
    }
    let (outcomes, counts) = counted(202).unwrap();
    assert_eq!(refusal(&outcomes, 202).code(), "empty_result");
    assert_eq!(counts.booleans.get(), 1);
    assert_eq!(counts.empty.get(), 1);
    eprintln!("sdk witness executed: m7_sdk_affine_boundary_and_authenticated_empty");
}
