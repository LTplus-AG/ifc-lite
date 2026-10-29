// SPDX-License-Identifier: MPL-2.0
//! Layer work starts only once the host's clips and opening cuts are complete.
use super::*;
use ifc_lite_geometry::program::transactions::{LayerAdmission, LayerUsages};

/// One source admission per product, under the canonical plan's layer predicate.
/// Openings and `begin` consume this result; neither admits again (#7955).
pub(super) type ProductLayers = Option<Result<LayerAdmission, &'static str>>;
pub(super) fn admit(entity: &DecodedEntity, router: &GeometryRouter, usages: &LayerUsages,
    decoder: &mut EntityDecoder) -> Result<ProductLayers, RetainedExecutionError> {
    if !router.is_material_layer_sliceable(entity.id) { return Ok(None); }
    let admitted = RetainedTraversal::layer_admission(entity, router, usages, decoder);
    error::budget_checkpoint()?;
    Ok(Some(admitted))
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn complete_layers(&mut self, plan: RetainedProductPlan) -> Result<(), RetainedExecutionError> {
        if let Some(spec) = self.layer_spec.take() {
            self.layer_start = Some(super::phase_timer::PhaseTimer::now());
            self.program = Some(self.resources.with_scope(|| self.traversal.layer_bands(plan, spec)).map_err(common)?);
            self.outer = Some(self.state.protocol.issue(WorkKind::PlainParts));
            self.layer_active = true;
        } else {
            self.plan = Some(plan.discharge_layers());
            self.state.stage = Stage::Complete;
        }
        Ok(())
    }
}
