// SPDX-License-Identifier: MPL-2.0
//! Shared runtime consumer of the borrowed common geometry program.
use super::model_context::retained::{ProductionLifecycle, RetainedContextError};
use super::session::{plan_in_scope, ProductState};
use super::session_owner::{OwnerStamp, ProductOwner};
use super::session_protocol::{WorkKind, WorkRequest};
use super::session_state::{Scopes, Stage};
use super::*;
use ifc_lite_geometry::document::{GeometryDocument, RetainedRecipe, RetainedRequest};
use ifc_lite_geometry::program::transactions::{
    Program as RetainedProgram, Ticket as RetainedTicket, Reply as RetainedReply,
    Traversal as RetainedTraversal, Plan as RetainedProductPlan,
    Value as LogicalRetainedValue, ValueRef, Definition as LogicalRetainedDefinition,
    Operation as RetainedPlanOperation, OperationKind as RetainedOperationKind,
    Requirement as RetainedRequirement, Resources as OwnedResourceContext, TransactionError,
};
use ifc_lite_geometry::resource::{self, ProgramStop, Reservation};
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
use ifc_lite_geometry_runtime::{MeshLimits, RetainedRealization, RuntimeOwner, SmlibWorker};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
mod witness;
use witness::RuntimeProductWitness;
mod acceptance;
mod validation;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod adversarial_tests;
mod batch;
mod issuance;
mod boolean_input;
use boolean_input::BooleanInput;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
#[cfg(test)]
mod native;
mod execute_async;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod async_tests;
mod runtime;
use runtime::{NumericalReceipt, ReceiptDomain, RetainedRuntime};
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
mod runtime_native;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
mod runtime_receipt_native;
mod seal;
mod value;
use issuance::{PendingRetainedOperation, IssuedRetainedOperation};
use value::RuntimeRealization;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
mod native_types;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
use native_types::{RealizationKind, RetainedProductExecution, IssuedCommonConstruction};
#[cfg(test)]
use native_types::{CommonRetainedRealization, CompletedCommonConstruction, RejectedCommonExecution};
mod predispatch;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod predispatch_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod affine_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod boolean_tests;
use predispatch::RuntimeRejectedExecution;
mod entry;
mod traversal;
mod source_admission;
use source_admission::SourceAdmission;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod tests;
use batch::{
    RuntimeCompleted, RuntimeIssued,
    RuntimeRejectedCompletion, RuntimeCancellation,
};
mod error;
use error::{RetainedExecutionError, ReceiptFailure, Unsupported, protocol, geometry, common};
pub(super) mod diagnostic;
mod diagnostic_source;
mod storage;
mod construction_storage;
use storage::Storage;
const ISSUED: u8 = 0;
const EXECUTING: u8 = 1;
const DELIVERED: u8 = 2;
const ACCEPTED: u8 = 3;
const CANCELLED: u8 = 4;
struct PendingRetainedTransaction<R: NumericalReceipt> {
    outer: WorkRequest,
    common: RetainedTicket,
    owner: OwnerStamp,
    reply: RetainedReply,
    operations: Vec<PendingRetainedOperation<R>>,
    cancellation: RuntimeCancellation<R>,
    _storage: Storage,
}
struct RuntimeProductExecution<'a, R: NumericalReceipt> {
    state: ProductState<'a>,
    context: &'a OwnedMeshProductionContext,
    owner: ProductOwner,
    scopes: Scopes,
    resources: OwnedResourceContext,
    program: Option<RetainedProgram<'a>>,
    outer: Option<WorkRequest>,
    traversal: RetainedTraversal,
    type_values: Vec<RetainedProductPlan>,
    type_map_members: Vec<u32>,
    pending: Option<PendingRetainedTransaction<R>>,
    prepared: Option<SourceAdmission>,
    ledger: Vec<(LogicalRetainedValue, Arc<RuntimeRealization<R>>)>,
    permits: Storage,
    scratch: Storage,
    plan: Option<RetainedProductPlan>,
    failed: bool,
    runtime_domain: Option<R::Domain>,
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    fn validate(
        &self,
        decoder: &EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<OwnerStamp, RetainedExecutionError> {
        self.resources
            .check()
            .map_err(RetainedExecutionError::Stopped)?;
        self.context
            .validate_decoder(decoder)
            .map_err(RetainedExecutionError::Source)?;
        if self.failed {
            return Err(protocol(ReceiptFailure::CancelledRetainedProduct));
        }
        if self.runtime_domain.as_ref().is_some_and(|owner| owner.incarnation().is_none()) {
            return Err(RetainedExecutionError::DomainRetired);
        }
        self.owner.validate(decoder, router).map_err(protocol)
    }
    fn issue_next(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter,
        worker: &impl RetainedRuntime<Receipt = R>) -> Result<Option<RuntimeIssued<R>>, RetainedExecutionError> {
        let result = self.issue_next_checked(decoder, router, worker);
        let result = self.resources.check().map_err(RetainedExecutionError::Stopped).and(result);
        if result.as_ref().is_err_and(|error| error.terminal()) { self.cancel(); }
        result
    }
    fn issue_next_checked(
        &mut self,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
        worker: &impl RetainedRuntime<Receipt = R>,
    ) -> Result<Option<RuntimeIssued<R>>, RetainedExecutionError> {
        self.validate(decoder, router)?;
        if self.runtime_domain.as_ref().is_some_and(|owner| !owner.same_domain(&worker.domain())) {
            return Err(protocol(ReceiptFailure::ForeignWorker));
        }
        if self.pending.is_some() {
            return Err(protocol(ReceiptFailure::OutstandingConstruction));
        }
        if !self.advance_source(decoder, router)? { return Ok(None); }
        let SourceAdmission { outer, ticket, stamp, reply, operations, _storage: _admission_storage } =
            self.prepared.take().ok_or_else(|| protocol(ReceiptFailure::MissingAdmission))?;
        let resources = self.resources.clone();
        if self.runtime_domain.is_none() { self.runtime_domain = Some(worker.domain()); }
        let (operations, storage) = resources.with_scope(|| self.prepare_operations(operations, worker))?;
        let (issued_operations, issued_storage) = resources.with_scope(|| self.copy_issued_operations(&operations))?;
        let cancellation = RuntimeCancellation {
            stage: Arc::new(batch::StageState::new(&resources)?),
            owner: worker.domain(),
        };
        // Recheck after every preparation scope has restored its TLS.
        self.validate(decoder, router)?;
        let issued = RuntimeIssued {
            operations: issued_operations,
            _storage: issued_storage,
            lifecycle: self.context.lifecycle(),
            resources,
            cancellation: cancellation.clone(),
            armed: true,
        };
        self.pending = Some(PendingRetainedTransaction {
            outer,
            common: ticket,
            owner: stamp,
            reply,
            operations,
            cancellation,
            _storage: storage,
        });
        Ok(Some(issued))
    }
    fn cancel(&mut self) {
        self.failed = true;
        if let Some(owner) = &self.runtime_domain { owner.retire(); }
        if let Some(pending) = &self.pending {
            pending.cancellation.cancel();
        }
        if let Some(program) = &mut self.program {
            program.cancel();
        }
        self.plan = None;
    }
    fn traversal_plan(&self) -> Option<&RetainedProductPlan> {
        self.plan.as_ref().filter(|_| !self.failed)
    }
    #[cfg(test)]
    fn discharged_count(&self) -> usize {
        self.ledger.len()
    }
    fn validate_witness(&self) -> Result<(), RetainedExecutionError> {
        self.resources
            .check()
            .map_err(RetainedExecutionError::Stopped)?;
        self.context
            .lifecycle().validate()
            .map_err(RetainedExecutionError::Source)?;
        let plan = self
            .traversal_plan()
            .ok_or_else(|| protocol(ReceiptFailure::UnfinishedProduct))?;
        self.validate_manifest(plan)
    }
    fn validate_manifest(&self, plan: &RetainedProductPlan) -> Result<(), RetainedExecutionError> {
        let result = self.resources.with_scope(|| self.validate_manifest_in_scope(plan));
        self.resources.check().map_err(RetainedExecutionError::Stopped)?;
        self.context.lifecycle().validate().map_err(RetainedExecutionError::Source)?;
        result
    }
    fn validate_manifest_in_scope(&self, plan: &RetainedProductPlan) -> Result<(), RetainedExecutionError> {
        for (index, value) in plan.values().enumerate() {
            let work = (index as u64).checked_add(self.ledger.len() as u64)
                .and_then(|work| work.checked_add(1))
                .ok_or_else(|| RetainedExecutionError::Stopped(resource::overflow()))?;
            resource::charge(resource::Cost { work, ..Default::default() })
                .map_err(RetainedExecutionError::Stopped)?.retain();
            if plan.values().take(index)
                .any(|other| other.slot() == value.slot())
            {
                return Err(protocol(ReceiptFailure::DuplicateSlot));
            }
            let (_, receipt) = self
                .ledger
                .iter()
                .find(|(v, _)| v.as_ref().definition() == value.definition())
                .ok_or_else(|| protocol(ReceiptFailure::UndischargedDefinition))?;
            receipt.validate_live().map_err(protocol)?;
            if receipt.definition != value.definition() { return Err(protocol(ReceiptFailure::ForeignRetainedManifestDefinition)); }
            if value.evaluated_empty() != Some(receipt.is_empty()) { return Err(protocol(ReceiptFailure::RetainedManifestOutcomeMismatch)); }
        }
        Ok(())
    }
}
impl<R: NumericalReceipt> Drop for RuntimeProductExecution<'_, R> {
    fn drop(&mut self) {
        if self.pending.is_some() {
            self.cancel();
        }
    }
}

#[cfg(test)]
mod contract_tests;
