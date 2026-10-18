// SPDX-License-Identifier: MPL-2.0
//! Opt-in request accounting around the actual canonical owned producer.
//! This accounts admitted geometry payloads, not opaque assembly allocations.
use super::*;
use super::owned_session::OwnedProductExecution;
use super::session_protocol::{WorkError, WorkPayload};
use super::session_work::{PartsOutcome, PrimaryOutcome};
use ifc_lite_geometry::resource::{self, Cost, ExecutionAccount, ProgramStop, Reservation};
use std::sync::Arc;

/// Typed terminal outcome of the opt-in owned Rust adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountedProductionError {
    Context(ProductionContextError),
    Stopped(ProgramStop),
}

impl std::fmt::Display for AccountedProductionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Self::Context(error) => write!(f,"{error}"), Self::Stopped(stop) => write!(f,"{stop}") }
    }
}
impl std::error::Error for AccountedProductionError {}

/// Produced meshes together with the request's admitted residency ownership.
///
/// Geometry payload admission does not cover numerical scratch, decoder/profile
/// allocations, assembly weld/palette workspaces, metadata, raster decoders or
/// downstream consumer copies. This result is therefore resource-unqualified.
/// Borrowing its data preserves the permit; copying it requires caller accounting.
pub struct AccountedElementMeshes {
    output: ProducedElementMeshes,
    _reservations: Vec<Reservation>,
    _account: ExecutionAccount,
}
impl AccountedElementMeshes {
    pub fn output(&self) -> &ProducedElementMeshes { &self.output }
    /// The current adapter has explicit opaque producer/assembly exclusions.
    pub fn is_resource_qualified(&self) -> bool { false }
}

/// Execute the canonical owned producer under an explicit resource account.
/// Nested canonical work inherits the active request rather than resetting it.
/// Bounded admission requires explicitly supported router cache ownership. The
/// default content-dedup cache is currently refused as unsupported coverage;
/// callers may explicitly disable it before entry. This adapter never changes
/// router configuration. Opaque assembly/producer coverage remains unqualified.
/// Native callers can retain this result through their output handoff; existing
/// native partial-stream cancellation and all browser batch signatures are intact.
pub fn produce_element_meshes_owned_accounted(job: &ElementMeshJob<'_>,
    context: &Arc<OwnedMeshProductionContext>, opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder, router: &GeometryRouter, account: &ExecutionAccount)
    -> Result<AccountedElementMeshes, AccountedProductionError> {
    session_canonical::with_source_resources(decoder, |decoder| {
    if let Err(stop) = account.check() {
        return Err(AccountedProductionError::Stopped(resource::stop(stop)));
    }
    account.scope(|| drive(job, context, opts, decoder, router, account))
    })
}

fn check() -> Result<(), AccountedProductionError> {
    resource::check_current().map_err(AccountedProductionError::Stopped)
}
fn context_error(error: WorkError) -> AccountedProductionError {
    match error {
        WorkError::StaleSource => AccountedProductionError::Context(ProductionContextError::StaleSource),
        WorkError::MismatchedSource => AccountedProductionError::Context(ProductionContextError::MismatchedSource),
        _ => panic!("canonical accounted production invariant: {error:?}"),
    }
}
// Preserve already reached source evidence on terminal return without running
// final hooks, retrying geometry, or publishing a partial product.
struct AccountedAttempt(Option<OwnedProductExecution>);
impl std::ops::Deref for AccountedAttempt {
    type Target = OwnedProductExecution;
    fn deref(&self) -> &Self::Target { self.0.as_ref().expect("live accounted attempt") }
}
impl std::ops::DerefMut for AccountedAttempt {
    fn deref_mut(&mut self) -> &mut Self::Target { self.0.as_mut().expect("live accounted attempt") }
}
impl Drop for AccountedAttempt {
    fn drop(&mut self) {
        if let Some(execution) = &mut self.0 {
            if let Some(scopes) = &mut execution.state.scopes { scopes.pending.publish_pending(); }
        }
    }
}

fn drive(job: &ElementMeshJob<'_>, context: &Arc<OwnedMeshProductionContext>,
    opts: &MeshProductionOptions, decoder: &mut EntityDecoder, router: &GeometryRouter,
    account: &ExecutionAccount)
    -> Result<AccountedElementMeshes, AccountedProductionError> {
    check()?;
    let execution = OwnedProductExecution::canonical(job, context, opts, decoder, router)
        .map_err(context_error)?;
    let mut execution = AccountedAttempt(Some(execution));
    check()?;
    let mut reservations = Vec::new();
    loop {
        check()?;
        let Some(request) = execution.request().map_err(context_error)? else { break };
        resource::charge(Cost { work: 1, ..Cost::default() })
            .map_err(AccountedProductionError::Stopped)?;
        let reply = execution.execute(request, decoder, router);
        // Legacy recovery adapters may swallow callback errors. The sticky
        // fault also wins over a source invalidation reached by that callback.
        check()?;
        let reply = reply.map_err(context_error)?;
        if let WorkPayload::Stopped(stop) = &reply.payload {
            return Err(AccountedProductionError::Stopped(*stop));
        }
        let bytes = payload_bytes(&reply.payload).map_err(AccountedProductionError::Stopped)?;
        let permit = resource::charge(Cost { output_bytes: bytes, live_bytes: bytes,
            ..Cost::default() }).map_err(AccountedProductionError::Stopped)?;
        let accepted = execution.accept(reply, decoder, router);
        check()?;
        accepted.map_err(|rejected|context_error(rejected.error))?;
        reservations.push(permit);
    }
    let output = execution.0.take().expect("live accounted attempt").finish(decoder, router);
    check()?;
    let output = output.map_err(context_error)?;
    Ok(AccountedElementMeshes { output, _reservations: reservations,
        _account: resource::current_account().unwrap_or_else(||account.clone()) })
}

/// Requested raw payload envelope before presentation can grow/copy it. Empty
/// instance placeholders still have a MeshData-sized admitted output header.
fn payload_bytes(payload: &WorkPayload) -> Result<u64, ProgramStop> {
    let mut bytes = Some(0usize);
    let mut add = |mesh: &Mesh, uv_len: usize| {
        let scalars = mesh.positions.len().checked_add(mesh.normals.len())
            .and_then(|n|n.checked_add(mesh.indices.len())).and_then(|n|n.checked_add(uv_len));
        let payload = scalars.and_then(|n|n.checked_mul(4))
            .and_then(|n|n.checked_add(std::mem::size_of::<MeshData>()));
        bytes = bytes.zip(payload).and_then(|(a,b)|a.checked_add(b));
    };
    match payload {
        WorkPayload::Primary(PrimaryOutcome::Candidate(parts)) => {
            for part in &parts.sub_meshes { add(&part.mesh, part.uvs.as_ref().map_or(0,Vec::len)); }
        }
        WorkPayload::TypeMap(Some(parts)) => for (mesh,uvs,_) in parts { add(mesh,uvs.len()); },
        WorkPayload::VoidedParts(PartsOutcome::Geometry(parts)) | WorkPayload::PlainParts(parts) => {
            for mesh in parts { add(mesh,0); }
        }
        _ => {}
    }
    bytes.and_then(|bytes|u64::try_from(bytes).ok()).ok_or_else(resource::overflow)
}
