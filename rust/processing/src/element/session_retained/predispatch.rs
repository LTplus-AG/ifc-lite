// SPDX-License-Identifier: MPL-2.0
//! Recoverable caller faults retain the original armed transaction.
use super::*;

pub(super) struct RuntimeRejectedExecution<R: NumericalReceipt> {
    pub reason: RetainedExecutionError,
    pub issued: Option<RuntimeIssued<R>>,
}
impl<R: NumericalReceipt> std::fmt::Debug for RuntimeRejectedExecution<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeRejectedExecution")
            .field("reason", &self.reason)
            .field("recoverable", &self.issued.is_some())
            .finish()
    }
}
impl<R: NumericalReceipt> std::fmt::Display for RuntimeRejectedExecution<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}
impl<R: NumericalReceipt> std::error::Error for RuntimeRejectedExecution<R> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(&self.reason) }
}
impl<R: NumericalReceipt> RuntimeRejectedExecution<R> {
    pub(super) fn predispatch(reason: RetainedExecutionError, issued: RuntimeIssued<R>) -> Box<Self> {
        Box::new(Self { reason, issued: Some(issued) })
    }
    pub(super) fn terminal(reason: RetainedExecutionError) -> Box<Self> {
        Box::new(Self { reason, issued: None })
    }
}
impl<R: NumericalReceipt> RuntimeIssued<R> {
    pub(super) fn validate_predispatch_state(&self) -> Result<(), RetainedExecutionError> {
        // The captured resource/source fault precedes caller mistakes and never
        // consults the unrelated ambient execution scope.
        check_resources(&self.resources)?;
        self.lifecycle.validate().map_err(RetainedExecutionError::Source)?;
        let stage = self.cancellation.stage.load(Ordering::Acquire);
        if stage != ISSUED {
            return Err(RetainedExecutionError::Transition(stage));
        }
        if self.cancellation.owner.incarnation().is_none() {
            return Err(RetainedExecutionError::DomainRetired);
        }
        Ok(())
    }
}
