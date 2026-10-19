// SPDX-License-Identifier: MPL-2.0
//! Checked consumption of common logical admissions. No final-net publication.
use super::{
    session::ProductState,
    session_owner::OwnerStamp,
    session_protocol::{WorkReply, WorkRequest},
    session_state::Stage,
    ElementMeshJob, EntityDecoder, GeometryRouter, MeshProductionOptions,
    OwnedMeshProductionContext, ProductionContextId,
};
use ifc_lite_geometry::{
    document::{EvaluationContract, GeometryDocument, RetainedRequest},
    program::{LogicalRetainedSlot, RetainedContract, RetainedPlanOperation, RetainedProductPlan},
};
use ifc_lite_geometry_runtime::{RetainedRealization, SmlibWorker};
use ifc_lite_geometry::resource::{OwnedResourceContext, ProgramStop};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};

mod acceptance;
mod entry;
mod native;
pub use native::{
    CompletedCommonConstruction, IssuedCommonConstruction, RejectedCommonConstruction,
    RetainedCancellation,
};

const ISSUED: u8 = 0;
const EXECUTING: u8 = 1;
const DELIVERED: u8 = 2;
const ACCEPTED: u8 = 3;
const CANCELLED: u8 = 4;
const ACCEPTING: u8 = 5;

#[derive(Debug)]
pub enum RetainedExecutionError {
    Source,
    Protocol(String),
    Unsupported(String),
    Runtime(String),
    Stopped(ProgramStop),
}
impl std::fmt::Display for RetainedExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for RetainedExecutionError {}
fn protocol(error: impl std::fmt::Debug) -> RetainedExecutionError {
    RetainedExecutionError::Protocol(format!("{error:?}"))
}

struct PendingRetainedTransaction {
    ticket: Arc<()>,
    stage: Arc<AtomicU8>,
    outer: WorkRequest,
    common: ifc_lite_geometry::program::ProgramRequest,
    context: ProductionContextId,
    owner: OwnerStamp,
    operation: RetainedPlanOperation,
    request: RetainedRequest,
    document: GeometryDocument,
    reply: Option<WorkReply>,
    cancellation: RetainedCancellation,
}
struct DischargedValue {
    slot: LogicalRetainedSlot,
    receipt: CompletedCommonConstruction,
}

/// Explicit opt-in execution of the existing reached product program. This
/// checkpoint can discharge constructions and accumulate logical product values.
/// Mapping/Boolean/opening families still refuse; appearance and placement remain
/// explicit plan requirements. There is deliberately no mesh publication method.
/// Captured resources cover reached work and ledger backing; source coefficient,
/// SDK heap, numerical scratch and presentation allocations remain unqualified.
pub struct RetainedProductExecution {
    state: ProductState,
    context: Arc<OwnedMeshProductionContext>,
    pending: Option<PendingRetainedTransaction>,
    ledger: Vec<DischargedValue>,
    plan: Option<RetainedProductPlan>,
    failed: bool,
    resources: OwnedResourceContext,
}
impl RetainedProductExecution {
    /// Progress only the same reached source/control continuation, stopping at
    /// its next real construction. No authored inventory or second source walk.
    pub fn issue_next(
        &mut self,
        worker: &SmlibWorker,
        decoder: &mut EntityDecoder<'_>,
        router: &GeometryRouter,
    ) -> Result<Option<IssuedCommonConstruction>, RetainedExecutionError> {
        if self.pending.is_some() {
            return Err(protocol("retained transaction outstanding"));
        }
        if self.failed {
            return Err(protocol("retained contract already refused"));
        }
        if self.plan.is_some() {
            return Ok(None);
        }
        self.context
            .validate_decoder(decoder)
            .map_err(|_| RetainedExecutionError::Source)?;
        self.state.owner.as_ref().ok_or_else(|| protocol("retained owner missing"))?
            .validate(decoder, router).map_err(protocol)?;
        let resources = self.resources.clone();
        let result = resources.with_scope(|| {
            resources.check().map_err(RetainedExecutionError::Stopped)?;
            let result = self.issue_inner(worker, decoder, router);
            resources.check().map_err(RetainedExecutionError::Stopped)?;
            result
        });
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn issue_inner(
        &mut self,
        worker: &SmlibWorker,
        decoder: &mut EntityDecoder<'_>,
        router: &GeometryRouter,
    ) -> Result<Option<IssuedCommonConstruction>, RetainedExecutionError> {
        loop {
            self.resources.check().map_err(RetainedExecutionError::Stopped)?;
            let request = self
                .state
                .request()
                .map_err(|error| match error {
                    super::session_protocol::WorkError::RetainedContract => {
                        RetainedExecutionError::Unsupported(
                            "retained type-map/host-opening entry is not implemented".into(),
                        )
                    }
                    other => protocol(other),
                })?
                .ok_or_else(|| {
                    RetainedExecutionError::Unsupported("no retained product traversal".into())
                })?;
            if request.inner.is_none() {
                self.state
                    .protocol
                    .before_execute(request)
                    .map_err(protocol)?;
                let attempt = self
                    .state
                    .pending_geometry
                    .take()
                    .ok_or_else(|| protocol("missing common continuation"))?;
                let plan = attempt
                    .program
                    .finish_retained()
                    .map_err(|error| RetainedExecutionError::Unsupported(error.to_string()))?;
                // Every reached value must have its own live, sealed discharge.
                if plan.values.len() != self.ledger.len()
                    || plan.values.iter().any(|value| {
                        !self.ledger.iter().any(|entry| {
                            entry.slot == value.slot()
                                && entry.receipt.realization.validate_live().is_ok()
                        })
                    })
                {
                    return Err(protocol("undischarged common retained value"));
                }
                self.state.protocol.executed(request, &[]);
                self.state.protocol.accepted();
                self.state.stage = Stage::Complete;
                self.plan = Some(plan);
                return Ok(None);
            }
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work: 1, ..Default::default()
            }).map_err(RetainedExecutionError::Stopped)?;
            let (reply, operation) = self
                .state
                .execute_admission(request, &self.context.borrowed(), decoder, router)
                .map_err(protocol)?;
            self.resources.check().map_err(RetainedExecutionError::Stopped)?;
            self.state
                .validate_reply(&reply, decoder, router)
                .map_err(protocol)?;
            let Some(operation) = operation else {
                self.state
                    .accept_admission(reply, &self.context.borrowed(), decoder, router)
                    .map_err(|error| protocol(error.error))?;
                continue;
            };
            let mut document = GeometryDocument::new();
            let definition = document
                .add_retained_construction(operation.construction().clone())
                .map_err(|error| RetainedExecutionError::Unsupported(error.to_string()))?;
            let runtime_request = document
                .prepare_retained_extrusion(
                    definition,
                    EvaluationContract::RetainedBrep,
                    worker.incarnation(),
                )
                .map_err(|error| RetainedExecutionError::Unsupported(error.to_string()))?;
            let ticket = Arc::new(());
            let stage = Arc::new(AtomicU8::new(ISSUED));
            let cancellation = RetainedCancellation {
                stage: stage.clone(),
                owner: worker.retained_owner(),
            };
            let issued = IssuedCommonConstruction {
                ticket: ticket.clone(),
                stage: stage.clone(),
                request: runtime_request.clone(),
                lifecycle: self.context.lifecycle(),
                cancellation: cancellation.clone(),
                resources: self.resources.clone(),
            };
            self.pending = Some(PendingRetainedTransaction {
                ticket,
                stage,
                outer: request,
                common: request.inner.expect("reached common construction"),
                context: self.context.id(),
                owner: reply.owner,
                operation,
                request: runtime_request,
                document,
                reply: Some(reply),
                cancellation,
            });
            return Ok(Some(issued));
        }
    }

    /// Foreign rejection leaves both the input and this pending transaction
    /// untouched. Only this transaction's expired source may retire its owner.
    pub fn accept(&mut self, work: CompletedCommonConstruction,
        decoder: &mut EntityDecoder<'_>, router: &GeometryRouter)
        -> Result<(), Box<RejectedCommonConstruction>> {
        if let Err(reason) = self.validate_intact(&work, decoder, router) {
            return Err(Box::new(RejectedCommonConstruction { reason, work }));
        }
        let resources = self.resources.clone();
        resources.with_scope(|| {
            if let Err(stop) = resources.check() {
                return Err(Box::new(RejectedCommonConstruction {
                    reason: RetainedExecutionError::Stopped(stop), work,
                }));
            }
            self.accept_checked(work, decoder, router)
        })
    }
    /// Inspection only: nonempty remaining requirements prohibit final-net use.
    pub fn traversal_plan(&self) -> Option<&RetainedProductPlan> {
        self.plan.as_ref()
    }
    pub fn discharged_count(&self) -> usize {
        self.ledger.len()
    }
    pub fn cancel(
        &mut self,
        decoder: &mut EntityDecoder<'_>,
        router: &GeometryRouter,
    ) -> Result<(), RetainedExecutionError> {
        if self.context.validate_source().is_err() {
            if let Some(pending) = &self.pending {
                pending.cancellation.cancel();
            }
            return Err(RetainedExecutionError::Source);
        }
        self.context
            .validate_decoder(decoder)
            .map_err(|_| RetainedExecutionError::Source)?;
        let owner = self
            .state
            .owner
            .as_mut()
            .ok_or_else(|| protocol("retained owner not admitted"))?;
        owner.validate(decoder, router).map_err(protocol)?;
        if let Some(pending) = &self.pending {
            pending.cancellation.cancel();
        }
        let resources = self.resources.clone();
        let mut scopes = super::session_state::ActiveScopes::new(
            self.state.scopes.take().expect("retained scopes"),
        );
        let attempt = &mut self.state.pending_geometry;
        resources.with_scope(|| owner
            .work(decoder, router, |_, router| {
                scopes.with_scope(|| {
                    if let Some(attempt) = attempt {
                        attempt
                            .program
                            .cancel_with_reports(router)
                            .expect("validated retained cancellation");
                    }
                })
            }))
            .map_err(protocol)?;
        self.state.scopes = Some(scopes.complete());
        self.failed = true;
        Ok(())
    }
}
impl Drop for RetainedProductExecution {
    fn drop(&mut self) {
        if let Some(pending) = &self.pending {
            pending.cancellation.cancel();
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod resource_tests;
