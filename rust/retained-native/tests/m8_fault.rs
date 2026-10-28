// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #3641: the third cut fails atomically, and the following product still runs.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::{block_on, NativeDomain, NativeReceipt, NativeWorker};
use std::{cell::Cell, rc::Rc};
struct KernelOnNthBoolean {
    inner: NativeWorker,
    calls: Rc<Cell<usize>>,
}
impl RetainedRuntime for KernelOnNthBoolean {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain { self.inner.domain() }
    fn incarnation(&self) -> u64 { self.inner.incarnation() }
}
impl AsyncRetainedExecutor for KernelOnNthBoolean {
    async fn invoke(&mut self, call: Invocation<'_, NativeReceipt>, limits: NumericalLimits) -> Result<NativeReceipt, RuntimeFault> {
        if matches!(call, Invocation::Boolean { .. }) {
            self.calls.set(self.calls.get() + 1);
            if self.calls.get() == 3 {
                return Err(RuntimeFault::kernel(7, "M8 injected third Boolean failure"));
            }
        }
        self.inner.invoke(call, limits).await
    }
}
#[test]
fn issue_3641_third_cut_failure_publishes_nothing_and_next_product_succeeds() {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "M8 requires the real SDK worker");
        eprintln!("SKIP M8 fault injection: IFCLITE_SMLIB_WORKER absent; not qualification");
        return;
    };
    let calls = Rc::new(Cell::new(0));
    let mut outcomes = Vec::new();
    let source = include_bytes!("../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
    block_on(run_model(SourceBundle::new(source.to_vec()),
        &ModelOptions { ids: Some([72209, 72216].into_iter().collect()), ..Default::default() },
        || NativeWorker::spawn(&path).map(|inner| KernelOnNthBoolean { inner, calls: calls.clone() }),
        |outcome| outcomes.push(outcome))).unwrap();
    eprintln!("M8 injected third cut: calls={} outcomeCount={}", calls.get(), outcomes.len());
    assert_eq!(calls.get(), 3, "must reach the third real-kernel cut boundary");
    assert_eq!(outcomes.len(), 2);
    match &outcomes[0] {
        ProductOutcome::Refused { product_id, refusal, origin, cut_times_ms, .. } => {
            assert_eq!(*product_id, 72209);
            assert_eq!(refusal.code(), "kernel_failure");
            // An executor RuntimeFault has no source origin; it is not an
            // opening-admission refusal. Preserve that existing contract.
            assert!(origin.is_none());
            assert_eq!(cut_times_ms.len(), 3);
        }
        other => panic!("third cut published partial geometry: {other:?}"),
    }
    assert!(matches!(&outcomes[1], ProductOutcome::Published(product) if product.product_id == 72216));
    println!("sdk witness executed: m8 third cut failure and recovery");
}
