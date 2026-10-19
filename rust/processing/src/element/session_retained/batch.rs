// SPDX-License-Identifier: MPL-2.0
//! Decoder-free detached lifecycle shared by synchronous and async numerical adapters.
use super::*;

#[derive(Clone)]
pub struct RetainedCancellation {
    pub(super) stage: Arc<AtomicU8>,
    pub(super) owner: target::Domain,
}
impl RetainedCancellation {
    /// Captured identity, callable independently of execution/worker borrows.
    pub fn cancel(&self) {
        self.stage.store(CANCELLED, Ordering::Release);
        self.owner.retire();
    }
}
pub struct IssuedCommonConstruction {
    pub(super) ticket: Arc<()>,
    pub(super) stage: Arc<AtomicU8>,
    pub(super) operations: Vec<super::issuance::IssuedRetainedOperation>,
    pub(super) lifecycle: super::super::model_context::ProductionLifecycle,
    pub(super) cancellation: RetainedCancellation,
    pub(super) resources: OwnedResourceContext,
    pub(super) armed: bool,
}
impl IssuedCommonConstruction {
    pub fn cancellation(&self) -> RetainedCancellation { self.cancellation.clone() }
    pub(super) fn validate_limits(&mut self, chord: f64, angle: f64, max_bytes: usize) -> Result<(), RetainedExecutionError> {
        if !chord.is_finite() || chord <= 0. || !angle.is_finite() || angle <= 0. || angle > 180. || max_bytes == 0 {
            // Known caller error: no Worker operation or stage transition occurred.
            self.armed = false;
            return Err(protocol("invalid retained numerical limits"));
        }
        Ok(())
    }
    pub(super) fn check_worker(&self, worker: &SelectedWorker) -> Result<(), RetainedExecutionError> {
        if !self.cancellation.owner.same_domain(&target::capture(worker)) {
            return Err(protocol("issued retained runtime mismatch"));
        }
        Ok(())
    }
    pub(super) fn checkpoint(&self) -> Result<(), RetainedExecutionError> {
        // An ancestor/resource fault takes precedence over cancellation/transport.
        self.resources.check().map_err(RetainedExecutionError::Stopped)?;
        if self.lifecycle.validate().is_err() { return Err(RetainedExecutionError::Source); }
        if self.stage.load(Ordering::Acquire) != EXECUTING || self.cancellation.owner.incarnation().is_none() {
            return Err(protocol("retained execution cancelled or retired"));
        }
        Ok(())
    }
    pub(super) fn preserve_fault<T>(&self, result: Result<T, RetainedExecutionError>) -> Result<T, RetainedExecutionError> {
        self.resources.check().map_err(RetainedExecutionError::Stopped)?;
        result
    }
    pub(super) fn start(&self) -> Result<Vec<Arc<CommonRetainedRealization>>, RetainedExecutionError> {
        self.resources.check().map_err(RetainedExecutionError::Stopped)?;
        self.stage.compare_exchange(ISSUED, EXECUTING, Ordering::AcqRel, Ordering::Acquire).map_err(protocol)?;
        self.checkpoint()?;
        self.resources.with_scope(|| {
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {work:1,..Default::default()})
                .map_err(RetainedExecutionError::Stopped)?.retain();
            let mut values = Vec::new();
            self.resources.reserve_headers(&mut values, self.operations.len()).map_err(RetainedExecutionError::Stopped)?.retain();
            Ok(values)
        })
    }
    pub(super) fn reserve_receipt(&self) -> Result<ifc_lite_geometry::resource::Reservation, RetainedExecutionError> {
        self.resources.with_scope(|| ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
            work:1,live_bytes:CommonRetainedRealization::header_bytes(),..Default::default()
        })).map_err(RetainedExecutionError::Stopped)
    }
    pub(super) fn finish(&self, realizations: Vec<Arc<CommonRetainedRealization>>)
        -> Result<CompletedCommonConstruction, RetainedExecutionError> {
        self.checkpoint()?;
        for value in &realizations { value.validate_live().map_err(protocol)?; }
        self.stage.compare_exchange(EXECUTING, DELIVERED, Ordering::AcqRel, Ordering::Acquire).map_err(protocol)?;
        Ok(CompletedCommonConstruction {ticket:self.ticket.clone(),stage:self.stage.clone(),realizations})
    }
}
#[derive(Debug)]
pub struct CompletedCommonConstruction {
    pub(super) ticket: Arc<()>,
    pub(super) stage: Arc<AtomicU8>,
    pub(super) realizations: Vec<Arc<CommonRetainedRealization>>,
}
impl CompletedCommonConstruction {
    pub fn realizations(&self) -> &[Arc<CommonRetainedRealization>] { &self.realizations }
    pub fn realization(&self) -> Option<&RetainedRealization> { self.realizations.first().and_then(|v|v.construction()) }
}
#[derive(Debug)]
pub struct RejectedCommonConstruction {
    pub reason: RetainedExecutionError,
    pub work: CompletedCommonConstruction,
}

impl Drop for IssuedCommonConstruction {
    fn drop(&mut self) { if self.armed { self.cancellation.cancel(); } }
}
