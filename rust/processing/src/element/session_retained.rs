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
    program::{RetainedContract, RetainedPlanOperation, RetainedProductPlan},
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
mod value;
mod issuance;
pub use value::CommonRetainedRealization;
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
    operations: Vec<PendingRetainedOperation>,
    reply: Option<WorkReply>,
    cancellation: RetainedCancellation,
}
enum PendingRetainedOperation {
    Construction { expected: Box<RetainedPlanOperation>, request: RetainedRequest, document: GeometryDocument },
    Affine { expected: Box<RetainedPlanOperation>, input: Arc<CommonRetainedRealization>, matrix: [f64;16] },
    Boolean { expected: Box<RetainedPlanOperation>, inputs: [Arc<CommonRetainedRealization>;2] },
}
impl PendingRetainedOperation {
    fn into_expected(self) -> Box<RetainedPlanOperation> {
        match self { Self::Construction {expected,..} | Self::Affine {expected,..} | Self::Boolean {expected,..}=>expected }
    }

    fn expected(&self) -> &RetainedPlanOperation {
        match self { Self::Construction {expected,..} | Self::Affine {expected,..} | Self::Boolean {expected,..} => expected }
    }
}
impl PendingRetainedTransaction {
    #[cfg(test)]
    fn construction(&self) -> (&RetainedPlanOperation, &RetainedRequest, &GeometryDocument) {
        match &self.operations[0] { PendingRetainedOperation::Construction {expected,request,document} =>
            (expected,request,document), _=>panic!("construction test accessor") }
    }
}
struct DischargedValue {
    operation: Box<RetainedPlanOperation>,
    receipt: Arc<CommonRetainedRealization>,
}

/// Explicit opt-in execution of the existing reached product program. This
/// checkpoint discharges constructions, physical affine copies and ordered binary
/// Boolean operations from the existing common continuations. Proper rigid mapping
/// and late product placement remain logical metadata. Halfspace, opening, layer
/// and appearance closure remain explicit gaps. There is no mesh publication method.
/// Captured resources cover reached work and ledger backing; source coefficient,
/// SDK heap, numerical scratch and presentation allocations remain unqualified.
pub struct RetainedProductExecution {
    state: ProductState,
    context: Arc<OwnedMeshProductionContext>,
    pending: Option<PendingRetainedTransaction>,
    ledger: Vec<DischargedValue>,
    plan: Option<RetainedProductPlan>,
    type_values:Vec<ifc_lite_geometry::program::LogicalRetainedValue>,
    failed: bool,
    resources: OwnedResourceContext,
}
impl RetainedProductExecution {
    /// Progress only the same reached source/control continuation, stopping at
    /// its next real operation batch. No authored inventory or second source walk.
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
            self.validate_definitions(worker)?;
            let request = self.state.request().map_err(|error|match error {
                super::session_protocol::WorkError::Geometry(ifc_lite_geometry::program::ProgramError::TraversalStopped(stop))=>RetainedExecutionError::Stopped(stop),
                super::session_protocol::WorkError::RetainedContract=>RetainedExecutionError::Unsupported("retained host-opening entry is not implemented".into()),
                error=>protocol(error),
            })?;
            let Some(request)=request else {
                if matches!(self.state.stage,Stage::Complete) {
                    let plan=RetainedProductPlan::from_type_values(std::mem::take(&mut self.type_values)).map_err(protocol)?;
                    self.validate_manifest(&plan)?;self.plan=Some(plan);return Ok(None);
                }
                return Err(RetainedExecutionError::Unsupported("no retained product traversal".into()));
            };
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
                let is_type=matches!(attempt.kind,super::session_protocol::WorkKind::TypeMap {..});
                let plan=if let super::session_protocol::WorkKind::TypeMap {class,..}=attempt.kind {
                    attempt.program.finish_retained_type_map(self.state.job.id,class,self.state.element_color)}
                    else {attempt.program.finish_retained()}
                    .map_err(|error| RetainedExecutionError::Unsupported(error.to_string()))?;
                self.validate_manifest(&plan)?;
                self.state.protocol.executed(request, &[]);
                self.state.protocol.accepted();
                if is_type {
                    self.resources.reserve_headers(&mut self.type_values,plan.values.len()).map_err(RetainedExecutionError::Stopped)?.retain();
                    self.type_values.extend(plan.values);continue;
                }
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
                .map_err(|error| match self.resources.check() {
                    Err(stop)=>RetainedExecutionError::Stopped(stop),
                    Ok(())=>match error {
                        super::session_protocol::WorkError::Geometry(ifc_lite_geometry::program::ProgramError::TraversalStopped(stop))=>RetainedExecutionError::Stopped(stop),
                        other=>protocol(other),
                    },
                })?;
            self.resources.check().map_err(RetainedExecutionError::Stopped)?;
            self.state
                .validate_reply(&reply, decoder, router)
                .map_err(protocol)?;
            self.validate_definitions(worker)?;
            if operation.is_empty() {
                self.state.accept_admission(reply, &self.context.borrowed(), decoder, router)
                    .map_err(|error| protocol(error.error))?;
                continue;
            }
            let operations = self.prepare_operations(operation, worker)?;
            let issued_operations = self.copy_issued_operations(&operations)?;
            let ticket = Arc::new(());
            let stage = Arc::new(AtomicU8::new(ISSUED));
            let cancellation = RetainedCancellation {
                stage: stage.clone(),
                owner: worker.retained_owner(),
            };
            let issued = IssuedCommonConstruction {
                ticket: ticket.clone(),
                stage: stage.clone(),
                operations: issued_operations,
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
                operations,
                reply: Some(reply),
                cancellation,
            });
            return Ok(Some(issued));
        }
    }

    fn validate_definitions(&self, worker: &SmlibWorker) -> Result<(), RetainedExecutionError> {
        for entry in &self.ledger {
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work:1,..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
            entry.receipt.validate_live().map_err(protocol)?;
            if entry.receipt.owner().incarnation() != Some(worker.incarnation()) {
                return Err(protocol("retained definition belongs to a different runtime generation"));
            }
        }
        Ok(())
    }
    fn validate_manifest(&self, plan: &RetainedProductPlan) -> Result<(), RetainedExecutionError> {
        let mut seen=Vec::new();
        self.resources.reserve_headers(&mut seen,plan.values.len())
            .map_err(RetainedExecutionError::Stopped)?.retain();
        for value in &plan.values {
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work:(seen.len()+self.ledger.len()) as u64,..Default::default()
            }).map_err(RetainedExecutionError::Stopped)?.retain();
            if seen.contains(&value.slot()) || !self.ledger.iter().any(|entry|
                entry.operation.value().definition()==value.definition() && entry.receipt.validate_live().is_ok()) {
                return Err(protocol("duplicate occurrence or undischarged retained definition"));
            }
            seen.push(value.slot());
        }
        Ok(())
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

#[cfg(test)]
mod mapping_tests;

#[cfg(test)]
mod styled_tests;

#[cfg(test)]
mod operation_tests;
