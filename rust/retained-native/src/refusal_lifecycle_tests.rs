// SPDX-License-Identifier: MPL-2.0
//! #7955: actual SDK ownership and publication after the refusal cascade.
use crate::{block_on, NativeWorker, NativeReceipt, NativeDomain};
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use std::{cell::Cell, rc::Rc};

const CASCADE: &str = include_str!("../../../tests/fixtures/synthetic-retained/refusal-cascade.ifc");
struct Observed {
    worker: NativeWorker,
    baseline: usize,
    calls: Rc<Cell<usize>>,
}
impl RetainedRuntime for Observed {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain { self.worker.domain() }
    fn incarnation(&self) -> u64 { self.worker.incarnation() }
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self, call: Invocation<'_, NativeReceipt>, limits: NumericalLimits)
        -> Result<NativeReceipt, RuntimeFault> {
        // Each previous product has returned/refused before the next host is
        // invoked. Release replies must succeed on the SAME live process.
        assert_eq!(self.worker.0.retained_live_object_count().unwrap(), self.baseline,
            "refused host leaked a kernel object");
        assert!(matches!(call, Invocation::Construction(_)));
        self.calls.set(self.calls.get() + 1);
        self.worker.invoke(call, limits).await
    }
}
fn published(rows: &[ProductOutcome]) -> &ShapeOnlyProduct {
    rows.iter().find_map(|row| match row {
        ProductOutcome::Published(shape) if shape.product_id == 104 => Some(shape), _ => None,
    }).unwrap_or_else(|| panic!("valid #104 must publish: {rows:?}"))
}
#[test]
fn issue_7955_real_sdk_refusals_preserve_worker_and_release_objects() {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib worker required");
        eprintln!("SKIP retained refusal lifecycle: set IFCLITE_SMLIB_WORKER; not SDK evidence");
        return;
    };
    let mut native = NativeWorker::spawn(&path).unwrap();
    let baseline = native.0.retained_live_object_count().unwrap();
    assert_eq!(baseline, 0, "qualification left no kernel objects");
    let incarnation = native.incarnation();
    let calls = Rc::new(Cell::new(0));
    let mut worker = Some(Observed { worker: native, baseline, calls: calls.clone() });
    let mut rows = Vec::new();
    let source = SourceBundle::new(CASCADE.as_bytes().to_vec());
    let summary = block_on(run_model_with_worker(source.clone(), &ModelOptions::default(),
        &mut worker, || panic!("typed source refusals must not acquire a replacement"),
        |o, _| rows.push(o))).unwrap();
    assert_eq!((summary.candidates, summary.published, summary.restarts), (9,1,0));
    assert_eq!(summary.by_code.get("opening_unsupported"), Some(&4));
    assert_eq!(summary.by_code.get("operation_unsupported"), Some(&4));
    for id in 100..104 {
        assert!(rows.iter().any(|row| matches!(row, ProductOutcome::Refused {
            product_id, refusal: RetainedProductRefusal::OpeningUnsupported, .. } if *product_id == id)),
            "host #{id} must refuse atomically");
    }
    assert_eq!(calls.get(), 5, "four host constructions before refusals, then valid host");
    let worker = worker.as_mut().unwrap();
    assert_eq!(worker.incarnation(), incarnation);
    assert_eq!(worker.worker.0.retained_live_object_count().unwrap(), baseline);
    let reused = published(&rows);
    assert_eq!(reused.parts.len(), 1);
    let mut fresh = Vec::new();
    crate::run_model_native(source, &path,
        &ModelOptions { ids: Some([104].into_iter().collect()), ..Default::default() },
        |o| fresh.push(o)).unwrap();
    let fresh = published(&fresh);
    assert_eq!(reused.parts[0].positions, fresh.parts[0].positions);
    assert_eq!(reused.parts[0].indices, fresh.parts[0].indices);
    assert_eq!(reused.parts[0].world_from_object, fresh.parts[0].world_from_object);
    println!("sdk witness executed: retained refusal lifecycle and live objects");
}
