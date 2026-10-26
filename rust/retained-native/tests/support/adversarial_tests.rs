// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: source faults remain product-atomic and do not become exact retries.
use super::support::*;
#[test]
fn late_unsupported_item_keeps_earlier_construction_private() {
    let text = BOX
        .replace("'SweptSolid',(#19)", "'SweptSolid',(#19,#90)")
        .replace(
            "ENDSEC;\nEND-ISO",
            "#90=IFCFACETEDBREP(#91);#91=IFCCLOSEDSHELL(());\nENDSEC;\nEND-ISO",
        );
    let Some(outcomes) = native(&text) else {
        return;
    };
    assert_eq!(refusal(&outcomes, 27).code(), "operation_unsupported");
}
#[test]
fn zero_deadline_is_reported_before_transport() {
    let mut options = ifc_lite_retained_native::ModelOptions::default();
    options.product_budget.deadline_ms = 0;
    let (_, outcomes) = inert(BOX, &options);
    assert_eq!(refusal(&outcomes, 27).code(), "deadline_exceeded");
}

// External executors can return valid geometry for the wrong operation. These
// are real SDK receipts: C must authenticate them before exposing any part.
use ifc_lite_processing::element::retained_runtime::{
    run_model, AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedRuntime, RuntimeFault,
};
use ifc_lite_retained_native::{block_on, NativeDomain, NativeReceipt, NativeWorker};
#[derive(Clone, Copy)]
enum Corruption {
    BooleanOperator,
    AffineFrame,
}
struct CorruptWorker {
    worker: NativeWorker,
    corruption: Corruption,
}
impl RetainedRuntime for CorruptWorker {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain {
        self.worker.domain()
    }
    fn incarnation(&self) -> u64 {
        self.worker.incarnation()
    }
}
impl AsyncRetainedExecutor for CorruptWorker {
    async fn invoke(
        &mut self,
        call: Invocation<'_, NativeReceipt>,
        limits: NumericalLimits,
    ) -> Result<NativeReceipt, RuntimeFault> {
        let call = match (self.corruption, call) {
            (Corruption::BooleanOperator, Invocation::Boolean { left, right, .. }) => {
                Invocation::Boolean {
                    left,
                    right,
                    operation: ifc_lite_geometry::BoolOp::Intersection,
                }
            }
            (
                Corruption::AffineFrame,
                Invocation::Affine {
                    input,
                    mut column_major,
                },
            ) => {
                column_major[3] = f64::from_bits(column_major[3].to_bits() ^ (1u64 << 63));
                Invocation::Affine {
                    input,
                    column_major,
                }
            }
            (_, call) => call,
        };
        self.worker.invoke(call, limits).await
    }
}
#[test]
fn wrong_real_operation_receipts_cannot_publish_any_part() {
    let Some(path) = worker_path() else {
        eprintln!("SKIP: set IFCLITE_SMLIB_WORKER");
        return;
    };
    let boolean = SOURCE.replace(
        "#13=IFCEXTRUDEDAREASOLID",
        "#13=IFCBOOLEANRESULT(.UNION.,#113,#23);#113=IFCEXTRUDEDAREASOLID",
    );
    let affine = SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCBOOLEANRESULT(.UNION.,#813,#23);#813=IFCMAPPEDITEM(#81,#82);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));ENDSEC;END-ISO");
    for (text, corruption) in [
        (boolean, Corruption::BooleanOperator),
        (affine, Corruption::AffineFrame),
    ] {
        let mut outcomes = Vec::new();
        block_on(run_model(
            ifc_lite_core::SourceBundle::new(text.into_bytes()),
            &Default::default(),
            || NativeWorker::spawn(&path).map(|worker| CorruptWorker { worker, corruption }),
            |o| outcomes.push(o),
        ))
        .unwrap();
        assert_eq!(refusal(&outcomes, 10).code(), "contract_breach");
        shape(&outcomes, 20);
    }
}
