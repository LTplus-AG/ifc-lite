// SPDX-License-Identifier: MPL-2.0
//! Decoder-free runtime work. The original common reply stays in processing.
use super::*;
use ifc_lite_geometry_runtime::{MeshLimits, RuntimeOwner};

#[derive(Clone)]
pub struct RetainedCancellation {
    pub(super) stage: Arc<AtomicU8>,
    pub(super) owner: RuntimeOwner,
}
impl RetainedCancellation {
    /// Independent capability: usable without borrowing the execution or worker.
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
}
impl IssuedCommonConstruction {
    pub fn cancellation(&self) -> RetainedCancellation {
        self.cancellation.clone()
    }
    /// Executes only the issued immutable recipe. Errors never select exact work.
    pub fn execute(
        self,
        worker: &mut SmlibWorker,
        chord_metres: f64,
        angle_degrees: f64,
        limits: MeshLimits,
    ) -> Result<CompletedCommonConstruction, RetainedExecutionError> {
        self.stage
            .compare_exchange(ISSUED, EXECUTING, Ordering::AcqRel, Ordering::Acquire)
            .map_err(protocol)?;
        if self.lifecycle.validate().is_err() {
            self.cancellation.cancel();
            return Err(RetainedExecutionError::Source);
        }
        if self.cancellation.owner.incarnation() != Some(worker.incarnation()) {
            return Err(protocol("issued retained runtime mismatch"));
        }
        let resources = self.resources.clone();
        resources.with_scope(|| {
            if let Err(stop) = resources.check() {
                self.cancellation.cancel();
                return Err(RetainedExecutionError::Stopped(stop));
            }
            if let Err(stop) = ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work: 1, ..Default::default()
        }) {
            self.cancellation.cancel();
            return Err(RetainedExecutionError::Stopped(stop));
        }
        let mut realizations = Vec::new();
        match resources.reserve_headers(&mut realizations, self.operations.len()) {
            Ok(permit)=>permit.retain(),
            Err(stop)=>{self.cancellation.cancel();return Err(RetainedExecutionError::Stopped(stop));}
        }
        for operation in self.operations {
            if let Err(stop)=resources.check() {self.cancellation.cancel();return Err(RetainedExecutionError::Stopped(stop));}
            // Admit both the boxed sealed header and its shared receipt before
            // allocating them. Numerical buffers/SDK memory retain separate limits.
            let permit=match ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                live_bytes: CommonRetainedRealization::header_bytes(),..Default::default()
            }) {
                Ok(permit)=>permit,
                Err(stop)=>{self.cancellation.cancel();return Err(RetainedExecutionError::Stopped(stop));}
            };
            let value = operation.execute(worker, chord_metres, angle_degrees, limits, resources.clone())?;
            value.validate_live().map_err(protocol)?;
            permit.retain();
            realizations.push(Arc::new(value));
        }
        if self.lifecycle.validate().is_err() {
            self.cancellation.cancel();
            return Err(RetainedExecutionError::Source);
        }
        if let Err(stop) = resources.check() {
            self.cancellation.cancel();
            return Err(RetainedExecutionError::Stopped(stop));
        }
        let work = CompletedCommonConstruction {
            ticket: self.ticket,
            stage: self.stage.clone(),
            realizations,
        };
        for value in &work.realizations { value.validate_live().map_err(protocol)?; }
        self.stage
            .compare_exchange(EXECUTING, DELIVERED, Ordering::AcqRel, Ordering::Acquire)
            .map_err(protocol)?;
        Ok(work)
        })
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
    pub fn realization(&self) -> Option<&RetainedRealization> {
        self.realizations.first().and_then(|v|v.construction())
    }
}
#[derive(Debug)]
pub struct RejectedCommonConstruction {
    pub reason: RetainedExecutionError,
    pub work: CompletedCommonConstruction,
}
