// SPDX-License-Identifier: MPL-2.0
//! Native wall-clock observations; never part of a deterministic product report.
use crate::{NativeDomain, NativeReceipt, NativeWorker};
use ifc_lite_processing::element::retained_runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedRuntime, RuntimeFault,
};
use std::{cell::Cell, rc::Rc, time::Instant};
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeTimings {
    pub startup_and_qualification_ms: f64,
    pub construction_ms: f64,
    pub construction_count: usize,
    pub affine_ms: f64,
    pub boolean_ms: f64,
    pub controller_and_publication_ms: f64,
    pub total_ms: f64,
    pub product_ms: f64,
}
pub(crate) struct MeasuredWorker {
    pub worker: NativeWorker,
    pub timing: Rc<Cell<NativeTimings>>,
}
impl RetainedRuntime for MeasuredWorker {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain {
        self.worker.domain()
    }
    fn incarnation(&self) -> u64 {
        self.worker.incarnation()
    }
}
impl AsyncRetainedExecutor for MeasuredWorker {
    async fn invoke(
        &mut self,
        call: Invocation<'_, NativeReceipt>,
        limits: NumericalLimits,
    ) -> Result<NativeReceipt, RuntimeFault> {
        let operation = match &call {
            Invocation::Construction(_) => 0,
            Invocation::Affine { .. } => 1,
            Invocation::Boolean { .. } => 2,
        };
        let start = Instant::now();
        let result = self.worker.invoke(call, limits).await;
        let elapsed = start.elapsed().as_secs_f64() * 1000.;
        let mut timing = self.timing.get();
        match operation {
            0 => {
                timing.construction_ms += elapsed;
                timing.construction_count += 1;
            }
            1 => timing.affine_ms += elapsed,
            _ => timing.boolean_ms += elapsed,
        }
        self.timing.set(timing);
        result
    }
}
