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
    pub(super) request: RetainedRequest,
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
        let realization = worker
            .evaluate_retained_extrusion(self.request, chord_metres, angle_degrees, limits);
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
            realization: realization.map_err(|error| RetainedExecutionError::Runtime(error.to_string()))?,
        };
        work.realization
            .validate_live()
            .map_err(|error| RetainedExecutionError::Runtime(error.to_string()))?;
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
    pub(super) realization: RetainedRealization,
}
impl CompletedCommonConstruction {
    pub fn realization(&self) -> &RetainedRealization {
        &self.realization
    }
}
#[derive(Debug)]
pub struct RejectedCommonConstruction {
    pub reason: RetainedExecutionError,
    pub work: CompletedCommonConstruction,
}
