// SPDX-License-Identifier: MPL-2.0
//! Qualify each model worker once, including replacements, before dispatch.
use super::{receipt::BrowserReceipt, BrowserCancellation, BrowserWorker};
use ifc_lite_processing::element::retained_runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedRuntime, RuntimeFault,
};

pub(crate) struct ModelWorker {
    worker: BrowserWorker,
    qualified: bool,
}
#[cfg(test)]
#[path = "model_test_driver.rs"]
pub(crate) mod test_driver;

impl ModelWorker {
    pub(crate) fn new() -> Result<Self, RuntimeFault> {
        #[cfg(test)]
        if let Some(worker) = test_driver::worker()? {
            return Ok(Self { worker, qualified: false });
        }
        Ok(Self {
            worker: BrowserWorker::new()?,
            qualified: false,
        })
    }
}
impl RetainedRuntime for ModelWorker {
    type Receipt = BrowserReceipt;
    fn domain(&self) -> BrowserCancellation {
        self.worker.cancellation()
    }
    fn incarnation(&self) -> u64 {
        self.worker.incarnation()
    }
}
impl AsyncRetainedExecutor for ModelWorker {
    async fn invoke(
        &mut self,
        call: Invocation<'_, BrowserReceipt>,
        limits: NumericalLimits,
    ) -> Result<BrowserReceipt, RuntimeFault> {
        if !self.qualified {
            self.worker.qualify().await?;
            self.qualified = true;
        }
        self.worker.invoke(call, limits).await
    }
}
