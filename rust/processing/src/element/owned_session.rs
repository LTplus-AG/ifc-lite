// SPDX-License-Identifier: MPL-2.0
//! One immutable model snapshot around the canonical transition implementation.
use super::session::{Live, ProductState};
use super::session_protocol::WorkError;
use super::*;
use ifc_lite_geometry::resource::ProgramStop;

/// A product bound to one immutable model snapshot. Every transition uses the
/// captured snapshot, whose tickets carry its identity, and refuses once the
/// model explicitly invalidated the snapshot's source. The resumable mode
/// (`session_resumable`) is the scheduling boundary: only dormant work may
/// move to another compatible execution owner.
pub(super) struct OwnedProductExecution<'j> {
    pub(super) state: ProductState<'j>,
    pub(super) context: &'j OwnedMeshProductionContext,
}
impl<'j> OwnedProductExecution<'j> {
    /// Plan inside the driver's open epoch.
    fn plan_live(
        job: &'j ElementMeshJob<'j>,
        context: &'j OwnedMeshProductionContext,
        opts: &MeshProductionOptions,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
        live: Live,
    ) -> Result<Self, WorkError> {
        context.validate_source().map_err(|_| WorkError::StaleSource)?;
        let state = ProductState::plan_live(job, &context.borrowed(), opts, decoder, router, live);
        Ok(Self { state, context })
    }

    pub(super) fn validate(&self) -> Result<(), WorkError> {
        self.context.validate_source().map_err(|_| WorkError::StaleSource)
    }

    fn step_live(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<bool, WorkError> {
        self.validate()?;
        self.state.step_live(&self.context.borrowed(), decoder, router)
    }

    fn finish_live(
        self,
        router: &GeometryRouter,
        output: &mut Option<ProducedElementMeshes>,
    ) -> Result<Option<ProgramStop>, WorkError> {
        self.validate()?;
        let context = self.context;
        let published = self.state.finish_live(router, output)?;
        // A final diagnostic callback may explicitly invalidate the model.
        context.validate_source().map_err(|_| WorkError::StaleSource)?;
        Ok(published)
    }
}

/// Canonical synchronous production over one owned immutable snapshot.
///
/// Returns `StaleSource` when the model explicitly invalidated the snapshot's
/// source, checked before any work, at every transition and again after the
/// final hooks, so a geometry callback that invalidates the source mid-product
/// never publishes. Nested products and decoder/router callbacks behave
/// exactly as on the borrowed [`produce_element_meshes`] entry.
pub fn produce_element_meshes_owned(
    job: &ElementMeshJob<'_>,
    context: &OwnedMeshProductionContext,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Result<ProducedElementMeshes, ProductionContextError> {
    session_canonical::with_source_resources(decoder, |decoder| {
        context.validate_source()?;
        if ifc_lite_geometry::resource::check_current().is_err() {
            return Ok(session_canonical::stopped_output());
        }
        drive(job, context, opts, decoder, router).map_err(public_error)
    })
}

/// Plan, advance every ticket and publish, inside one owner epoch.
fn drive(
    job: &ElementMeshJob<'_>,
    context: &OwnedMeshProductionContext,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Result<ProducedElementMeshes, WorkError> {
    let mut output = None;
    session_run::run_epoch(decoder, router, Some(context.id()), |decoder, router, live| {
        let mut execution = OwnedProductExecution::plan_live(job, context, opts, decoder, router, live)?;
        while execution.step_live(decoder, router)? {}
        execution.finish_live(router, &mut output)
    })?;
    output.ok_or(WorkError::Aborted)
}

#[cold]
#[inline(never)]
fn public_error(error: WorkError) -> ProductionContextError {
    match error {
        WorkError::StaleSource => ProductionContextError::StaleSource,
        // The synchronous driver consumes only its own tickets, so every other
        // refusal means an owner could not be admitted or kept.
        _ => ProductionContextError::OwnerUnavailable,
    }
}
