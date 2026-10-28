// SPDX-License-Identifier: MPL-2.0
//! Retained-only body/cut phases; the exact strategy ladder is unchanged.
use super::*;
use super::super::plan::PrimaryStrategy;

pub(super) enum OpeningPhase {
    Bodies { host: RetainedProductPlan, next: usize, cutters: Vec<(u32, RetainedProductPlan)> },
    Cuts,
}
pub(super) fn decoded_openings(context: &OwnedMeshProductionContext, id: u32,
    decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<Vec<DecodedEntity>, RetainedExecutionError> {
    let mut openings = Vec::new();
    // The canonical plan uses this same layer predicate. Let begin report its
    // layer refusal before looking at a malformed related opening.
    if router.is_material_layer_sliceable(id) {
        let element = decoder.decode_by_id(id).map_err(RetainedExecutionError::Core)?;
        let admitted = RetainedTraversal::layer_admission(&element, router, decoder);
        error::budget_checkpoint()?;
        if admitted.is_err() { return Ok(openings); } // begin reports layer precedence.
    }
    if let Some(ids) = context.borrowed().void_index.get(&id) {
        OwnedResourceContext::capture_current().reserve_headers(&mut openings, ids.len())
            .map_err(RetainedExecutionError::Stopped)?.retain();
        for &id in ids {
            error::budget_checkpoint()?;
            if router.opening_requires_subtraction(id, decoder) {
                openings.push(decoder.decode_by_id(id).map_err(RetainedExecutionError::Core)?);
            }
        }
    }
    Ok(openings)
}
pub(super) fn validate_openings(context: &OwnedMeshProductionContext, id: u32,
    openings: &[DecodedEntity], decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<(), RetainedExecutionError> {
    let mut next = 0;
    if let Some(ids) = context.borrowed().void_index.get(&id) {
        for &id in ids {
            error::budget_checkpoint()?;
            if !router.opening_requires_subtraction(id, decoder) { continue; }
            let actual = decoder.decode_by_id(id).map_err(RetainedExecutionError::Core)?;
            if openings.get(next).is_none_or(|given| given.id != id || given.ifc_type != actual.ifc_type
                || !Arc::ptr_eq(&given.attributes, &actual.attributes)) {
                return Err(RetainedExecutionError::Source(RetainedContextError::Mismatched));
            }
            next += 1;
        }
    }
    if next != openings.len() { return Err(RetainedExecutionError::Source(RetainedContextError::Mismatched)); }
    Ok(())
}
impl<'a, R: NumericalReceipt> RuntimeProductExecution<'a, R> {
    pub(super) fn opening_error(&self, error: RetainedExecutionError) -> RetainedExecutionError {
        if matches!(error, RetainedExecutionError::Opening { .. }) { return error; }
        match &self.openings {
            Some(OpeningPhase::Bodies { next, .. }) => RetainedExecutionError::Opening {
                opening: self.opening_entities[*next].id, inner: Box::new(error),
            },
            _ => error,
        }
    }
    pub(super) fn start_opening_program(&mut self) -> Result<bool, RetainedExecutionError> {
        let Some(phase) = &self.openings else { return Ok(false); };
        let program = match phase {
            OpeningPhase::Bodies { next, .. } => self.traversal.opening_body(&self.opening_entities[*next]),
            OpeningPhase::Cuts => return Err(protocol(ReceiptFailure::MissingProgram)),
        };
        self.program = Some(program);
        self.outer = Some(self.state.protocol.issue(WorkKind::Primary {
            strategy: PrimaryStrategy::VoidedSubmeshes, layer_class: 0,
        }));
        Ok(true)
    }
    /// Called only after the finished plan's ledger manifest is authenticated.
    pub(super) fn complete_opening_plan(&mut self, plan: RetainedProductPlan, kind: WorkKind)
        -> Result<bool, RetainedExecutionError> {
        match self.openings.take() {
            Some(OpeningPhase::Bodies { host, next, mut cutters }) => {
                if plan.values().len() == 0 {
                    return Err(RetainedExecutionError::Recipe(ifc_lite_geometry::document::RetainedRefusal::InvalidSource("opening body has no values")));
                }
                self.scratch.reserve(&self.resources, &mut cutters, 1)?;
                cutters.push((self.opening_entities[next].id, plan));
                if next + 1 < self.opening_entities.len() {
                    self.openings = Some(OpeningPhase::Bodies { host, next: next + 1, cutters });
                } else {
                    self.program = Some(self.resources.with_scope(|| self.traversal.opening_cuts(host, cutters)).map_err(common)?);
                    self.outer = Some(self.state.protocol.issue(kind));
                    self.openings = Some(OpeningPhase::Cuts);
                }
                Ok(true)
            }
            Some(OpeningPhase::Cuts) => {
                self.complete_layers(plan)?;
                Ok(true)
            }
            None if matches!(kind, WorkKind::Primary { strategy: PrimaryStrategy::VoidedSubmeshes, .. }) => {
                if plan.values().len() == 0 {
                    return Err(RetainedExecutionError::Unsupported(Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs));
                }
                if self.opening_entities.is_empty() {
                    return Err(RetainedExecutionError::Source(RetainedContextError::Mismatched));
                }
                self.openings = Some(OpeningPhase::Bodies { host: plan, next: 0, cutters: Vec::new() });
                Ok(true)
            }
            None => {
                self.complete_unvoided_plan(plan, kind)?;
                Ok(false)
            }
        }
    }
}
