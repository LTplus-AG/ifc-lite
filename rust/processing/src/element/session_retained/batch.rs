// SPDX-License-Identifier: MPL-2.0
use super::*;
pub struct RuntimeCancellation<R: NumericalReceipt> {
    pub(super) stage: Arc<AtomicU8>,
    pub(super) owner: R::Domain,
}
impl<R: NumericalReceipt> RuntimeCancellation<R> {
    pub fn cancel(&self) {
        self.stage.store(CANCELLED, Ordering::Release);
        self.owner.retire();
    }
}
pub struct RuntimeIssued<R: NumericalReceipt> {
    pub(super) operations: Vec<IssuedRetainedOperation<R>>,
    pub(super) lifecycle: ProductionLifecycle,
    pub(super) resources: OwnedResourceContext,
    pub(super) cancellation: RuntimeCancellation<R>,
    pub(super) armed: bool,
}
pub struct RuntimeCompleted<R: NumericalReceipt> {
    pub(super) cancellation: RuntimeCancellation<R>,
    pub(super) realizations: Vec<Arc<RuntimeRealization<R>>>,
}
impl<R: NumericalReceipt> RuntimeCompleted<R> {
    pub fn realizations(&self) -> &[Arc<RuntimeRealization<R>>] { &self.realizations }
}
pub struct RuntimeRejectedCompletion<R: NumericalReceipt> {
    pub reason: RetainedExecutionError,
    pub work: RuntimeCompleted<R>,
}
impl<R: NumericalReceipt> RuntimeIssued<R> {
    pub fn cancellation(&self) -> RuntimeCancellation<R> {
        self.cancellation.clone()
    }
    pub fn validate_numerical_limits(
        chord: f64,
        angle: f64,
        max_bytes: usize,
    ) -> Result<(), RetainedExecutionError> {
        if !chord.is_finite()
            || chord <= 0.
            || !angle.is_finite()
            || angle <= 0.
            || angle > 180.
            || max_bytes == 0
        {
            return Err(protocol("invalid retained numerical limits"));
        }
        Ok(())
    }
    pub(super) fn checkpoint(&self) -> Result<(), RetainedExecutionError> {
        self.resources
            .check()
            .map_err(RetainedExecutionError::Stopped)?;
        self.lifecycle
            .validate()
            .map_err(|_| RetainedExecutionError::Source)?;
        if self.cancellation.stage.load(Ordering::Acquire) != EXECUTING
            || self.cancellation.owner.incarnation().is_none()
        {
            return Err(protocol("retained transaction cancelled"));
        }
        Ok(())
    }
    // These lifecycle transitions are shared by synchronous execution and the
    // browser loop. Each call ends its resource scope before a numerical await.
    pub(super) fn start(&self) -> Result<(), RetainedExecutionError> {
        self.cancellation.stage.compare_exchange(ISSUED, EXECUTING, Ordering::AcqRel, Ordering::Acquire).map_err(protocol)?;
        self.checkpoint()
    }
    pub(super) fn reserve_realizations(&self) -> Result<Vec<Arc<RuntimeRealization<R>>>, RetainedExecutionError> {
        let mut realizations = Vec::new();
        self.resources.reserve_headers(&mut realizations, self.operations.len()).map_err(RetainedExecutionError::Stopped)?.retain();
        Ok(realizations)
    }
    pub(super) fn reserve_receipt(&self) -> Result<Reservation, RetainedExecutionError> {
        self.resources.with_scope(|| resource::charge(resource::Cost {
            work: 1, live_bytes: RuntimeRealization::<R>::header_bytes(), ..Default::default()
        })).map_err(RetainedExecutionError::Stopped)
    }
    pub(super) fn finish(&self, realizations: Vec<Arc<RuntimeRealization<R>>>)
        -> Result<RuntimeCompleted<R>, RetainedExecutionError> {
        self.checkpoint()?;
        self.cancellation.stage.compare_exchange(EXECUTING, DELIVERED, Ordering::AcqRel, Ordering::Acquire).map_err(protocol)?;
        Ok(RuntimeCompleted { cancellation: self.cancellation.clone(), realizations })
    }
}
impl<R: NumericalReceipt> Drop for RuntimeIssued<R> {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

impl<R: NumericalReceipt> Clone for RuntimeCancellation<R> {
    fn clone(&self) -> Self { Self { stage: self.stage.clone(), owner: self.owner.clone() } }
}
