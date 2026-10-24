// SPDX-License-Identifier: MPL-2.0
//! Shared runtime consumer of the borrowed common geometry program.
use super::model_context::ProductionLifecycle;
use super::session::{plan_in_scope, ProductState};
use super::session_owner::{OwnerStamp, ProductOwner};
use super::session_protocol::{WorkKind, WorkRequest};
use super::session_state::{Scopes, Stage};
use super::*;
use ifc_lite_geometry::document::{GeometryDocument, RetainedRecipe, RetainedRequest};
use ifc_lite_geometry::program::*;
use ifc_lite_geometry::resource::{self, OwnedResourceContext, ProgramStop, Reservation};
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
use ifc_lite_geometry_runtime::{MeshLimits, RetainedRealization, RuntimeOwner, SmlibWorker};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
mod derived_layers;
pub use derived_layers::{DerivedLayerBinding, MaterialInterfaceSide, DerivedLayersIssued, DerivedLayersCompleted, DerivedLayerManifest, DerivedLayerBandResult};
mod layers;
pub use layers::{RetainedLayerSource, RetainedLayerBand, RetainedLayerInterface, RetainedLayerReference};
pub(crate) use layers::LayerAssociationIndex;
mod witness;
mod openings;
pub use witness::RuntimeProductWitness;
mod acceptance;
mod validation;
mod clip_validation;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod adversarial_tests;
mod batch;
mod issuance;
mod boolean_input;
use boolean_input::BooleanInput;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
mod native;
mod execute_async;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod async_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod backing_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod profile_region_tests;
pub mod runtime;
use runtime::{NumericalReceipt, ReceiptDomain, RetainedRuntime};
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
mod runtime_native;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
mod runtime_receipt_native;
mod seal;
mod value;
use issuance::{PendingRetainedOperation, IssuedRetainedOperation};
pub use value::RuntimeRealization;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
mod native_types;
#[cfg(all(feature = "retained-native", not(target_arch = "wasm32")))]
pub use native_types::*;
mod predispatch;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod predispatch_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod affine_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod boolean_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod clip_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod finite_tests;
pub use predispatch::RuntimeRejectedExecution;
mod entry;
mod traversal;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod tests;
pub use batch::{
    RuntimeCompleted, RuntimeIssued,
    RuntimeRejectedCompletion, RuntimeCancellation,
};
#[derive(Debug)]
pub enum RetainedExecutionError {
    Source,
    Protocol(String),
    Unsupported(&'static str),
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
fn geometry(error: ifc_lite_geometry::Error) -> RetainedExecutionError {
    match error {
        ifc_lite_geometry::Error::ProgramStopped(stop) => RetainedExecutionError::Stopped(stop),
        other => protocol(other),
    }
}
fn common(error: RetainedProgramError) -> RetainedExecutionError {
    match error {
        RetainedProgramError::Stopped(stop) => RetainedExecutionError::Stopped(stop),
        other => protocol(other),
    }
}
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
}
pub struct RuntimeProductExecution<'a, R: NumericalReceipt> {
    state: ProductState<'a>,
    context: &'a OwnedMeshProductionContext,
    owner: ProductOwner,
    scopes: Scopes,
    resources: OwnedResourceContext,
    program: Option<RetainedProgram<'a>>,
    outer: Option<WorkRequest>,
    traversal: RetainedTraversal,
    type_values: Vec<LogicalRetainedValue>,
    type_map_members: rustc_hash::FxHashSet<u32>,
    layer_token: Option<Arc<derived_layers::LayerToken>>,
    layer_manifest: Option<DerivedLayerManifest<R>>,
    layer_pending: bool,
    layer_source: Option<Arc<RetainedLayerSource>>,
    pending: Option<PendingRetainedTransaction<R>>,
    ledger: Vec<(LogicalRetainedValue, Arc<RuntimeRealization<R>>)>,
    permits: Vec<Reservation>,
    plan: Option<RetainedProductPlan>,
    failed: bool,
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
            .map_err(|_| RetainedExecutionError::Source)?;
        if self.failed {
            return Err(protocol("cancelled retained product"));
        }
        self.owner.validate(decoder, router).map_err(protocol)
    }
    pub fn issue_next(
        &mut self,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
        worker: &impl RetainedRuntime<Receipt = R>,
    ) -> Result<Option<RuntimeIssued<R>>, RetainedExecutionError> {
        self.validate(decoder, router)?;
        if self.pending.is_some() {
            return Err(protocol("outstanding construction"));
        }
        loop {
            if self.plan.is_some() {
                return Ok(None);
            }
            let outer = self.outer.ok_or_else(|| protocol("missing outer request"))?;
            self.state
                .protocol
                .before_execute(outer)
                .map_err(protocol)?;
            let resources = self.resources.clone();
            let program = self
                .program
                .as_mut()
                .ok_or_else(|| protocol("missing program"))?;
            let ((ticket, admission), stamp) = resources
                .with_scope(|| {
                    self.owner.work(decoder, router, |d, r| {
                        self.scopes.with_scope(|| {
                            let ticket = program.request().map_err(common)?;
                            let admission = ticket
                                .map(|ticket| program.admit(ticket, r, d).map_err(common))
                                .transpose()?;
                            Ok::<_, RetainedExecutionError>((ticket, admission))
                        })
                    })
                })
                .map_err(protocol)
                .and_then(|(result, stamp)| {
                    result.map(|(ticket, admission)| ((ticket, admission), stamp))
                })?;
            let Some(ticket) = ticket else {
                self.finish_current_program(outer)?;
                if self.plan.is_none() { self.start_next_program(decoder,router)?; }
                continue;
            };
            let (reply, operations) = admission.ok_or_else(|| protocol("missing admission"))?;
            if operations.is_empty() {
                resources
                    .with_scope(|| {
                        self.owner.work(decoder, router, |_, r| {
                            self.scopes.with_scope(|| {
                                program.accept(reply, r).map_err(|e| common(e.error))
                            })
                        })
                    })
                    .map_err(protocol)?
                    .0?;
                continue;
            }
            let operations = resources.with_scope(|| self.prepare_operations(operations, worker))?;
            let issued_operations = resources.with_scope(|| self.copy_issued_operations(&operations))?;
            let cancellation = RuntimeCancellation {
                stage: Arc::new(AtomicU8::new(ISSUED)),
                owner: worker.domain(),
            };
            let issued = RuntimeIssued {
                operations: issued_operations,
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
            });
            return Ok(Some(issued));
        }
    }
    pub fn cancel(&mut self) {
        self.failed = true;
        if let Some(token) = &self.layer_token { token.stage.store(CANCELLED,Ordering::Release); }
        if let Some(pending) = &self.pending {
            pending.cancellation.cancel();
        }
        if let Some(program) = &mut self.program {
            program.cancel();
        }
        self.plan = None;
        self.layer_manifest = None;
    }
    pub fn traversal_plan(&self) -> Option<&RetainedProductPlan> {
        self.plan.as_ref().filter(|_| !self.failed)
    }
    pub fn discharged_count(&self) -> usize {
        self.ledger.len()
    }
    pub fn validate_witness(&self) -> Result<(), RetainedExecutionError> {
        self.resources
            .check()
            .map_err(RetainedExecutionError::Stopped)?;
        self.context
            .validate_source()
            .map_err(|_| RetainedExecutionError::Source)?;
        let plan = self
            .traversal_plan()
            .ok_or_else(|| protocol("unfinished product"))?;
        self.validate_manifest(plan)?;
        if let Some(manifest) = &self.layer_manifest { manifest.validate()?; }
        Ok(())
    }
    fn validate_manifest(&self, plan: &RetainedProductPlan) -> Result<(), RetainedExecutionError> {
        for (index, value) in plan.values.iter().enumerate() {
            if plan.values[..index]
                .iter()
                .any(|other| other.slot() == value.slot())
            {
                return Err(protocol("duplicate slot"));
            }
            let (_, receipt) = self
                .ledger
                .iter()
                .find(|(v, _)| v.definition() == value.definition())
                .ok_or_else(|| protocol("undischarged definition"))?;
            receipt.validate_live().map_err(protocol)?;
            if &receipt.definition != value.definition() { return Err(protocol("foreign retained manifest definition")); }
            if value.evaluated_empty() != Some(receipt.is_empty()) { return Err(protocol("retained manifest outcome mismatch")); }
        }
        Ok(())
    }
}
impl<R: NumericalReceipt> Drop for RuntimeProductExecution<'_, R> {
    fn drop(&mut self) {
        if self.pending.is_some() || (self.layer_token.is_some() && self.layer_manifest.is_none()) {
            self.cancel();
        }
    }
}

#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod opening_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod opening_witness;

#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod layer_tests;

#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod derived_layer_runtime_tests;
#[cfg(all(test, feature = "retained-native", not(target_arch = "wasm32")))]
mod layer_oracles;
