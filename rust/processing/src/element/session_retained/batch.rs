// SPDX-License-Identifier: MPL-2.0
use super::*;
type ReservedRealizations<R> = (Vec<Arc<RuntimeRealization<R>>>, Storage);
pub(super) struct StageState { stage: AtomicU8, _storage: Reservation }
impl StageState {
    pub(super) fn new(resources: &OwnedResourceContext) -> Result<Self, RetainedExecutionError> {
        let storage = resources.with_scope(|| resource::charge(resource::Cost {
            live_bytes: (std::mem::size_of::<Self>() + 2 * std::mem::size_of::<usize>()) as u64,
            ..Default::default()
        })).map_err(RetainedExecutionError::Stopped)?;
        Ok(Self { stage: AtomicU8::new(ISSUED), _storage: storage })
    }
}
impl std::ops::Deref for StageState {
    type Target = AtomicU8;
    fn deref(&self) -> &AtomicU8 { &self.stage }
}
pub(super) struct RuntimeCancellation<R: NumericalReceipt> {
    pub(super) stage: Arc<StageState>,
    pub(super) owner: R::Domain,
}
impl<R: NumericalReceipt> RuntimeCancellation<R> {
    pub(super) fn cancel(&self) {
        self.stage.store(CANCELLED, Ordering::Release);
        self.owner.retire();
    }
}
pub(super) struct RuntimeIssued<R: NumericalReceipt> {
    pub(super) operations: Vec<IssuedRetainedOperation<R>>,
    pub(super) lifecycle: ProductionLifecycle,
    pub(super) resources: OwnedResourceContext,
    pub(super) cancellation: RuntimeCancellation<R>,
    pub(super) armed: bool,
    pub(super) _storage: Storage,
}
pub(super) struct RuntimeCompleted<R: NumericalReceipt> {
    pub(super) cancellation: RuntimeCancellation<R>,
    pub(super) realizations: Vec<Arc<RuntimeRealization<R>>>,
    pub(super) _storage: Storage,
}
impl<R: NumericalReceipt> RuntimeCompleted<R> {
    #[cfg(test)]
    pub(super) fn realizations(&self) -> &[Arc<RuntimeRealization<R>>] { &self.realizations }
}
pub(super) struct RuntimeRejectedCompletion<R: NumericalReceipt> {
    pub reason: RetainedExecutionError,
    pub work: RuntimeCompleted<R>,
}
impl<R: NumericalReceipt> RuntimeIssued<R> {
    #[cfg(test)]
    pub(super) fn cancellation(&self) -> RuntimeCancellation<R> {
        self.cancellation.clone()
    }
    pub(super) fn validate_numerical_limits(
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
            return Err(protocol(ReceiptFailure::InvalidRetainedNumericalLimits));
        }
        Ok(())
    }
    pub(super) fn checkpoint(&self) -> Result<(), RetainedExecutionError> {
        check_resources(&self.resources)?;
        self.lifecycle
            .validate()
            .map_err(RetainedExecutionError::Source)?;
        let stage = self.cancellation.stage.load(Ordering::Acquire);
        if stage != EXECUTING {
            return Err(RetainedExecutionError::Transition(stage));
        }
        if self.cancellation.owner.incarnation().is_none() {
            return Err(RetainedExecutionError::DomainRetired);
        }
        Ok(())
    }
    // These lifecycle transitions are shared by synchronous execution and the
    // browser loop. Each call ends its resource scope before a numerical await.
    pub(super) fn start(&self) -> Result<(), RetainedExecutionError> {
        self.cancellation.stage.compare_exchange(ISSUED, EXECUTING, Ordering::AcqRel, Ordering::Acquire).map_err(protocol)?;
        self.checkpoint()
    }
    pub(super) fn reserve_realizations(&self) -> Result<ReservedRealizations<R>, RetainedExecutionError> {
        let mut realizations = Vec::new();
        let mut storage = Storage::default();
        storage.reserve(&self.resources, &mut realizations, self.operations.len())?;
        Ok((realizations, storage))
    }
    pub(super) fn reserve_receipt(&self) -> Result<Reservation, RetainedExecutionError> {
        self.resources.with_scope(|| resource::charge(resource::Cost {
            work: 1, live_bytes: RuntimeRealization::<R>::header_bytes(), ..Default::default()
        })).map_err(RetainedExecutionError::Stopped)
    }
    pub(super) fn finish(&self, realizations: Vec<Arc<RuntimeRealization<R>>>, storage: Storage)
        -> Result<RuntimeCompleted<R>, RetainedExecutionError> {
        self.checkpoint()?;
        self.cancellation.stage.compare_exchange(EXECUTING, DELIVERED, Ordering::AcqRel, Ordering::Acquire).map_err(protocol)?;
        Ok(RuntimeCompleted { cancellation: self.cancellation.clone(), realizations, _storage: storage })
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
