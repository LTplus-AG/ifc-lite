// SPDX-License-Identifier: MPL-2.0
//! Non-cloneable provisional whole-product removal evidence. It is minted only
//! after sealed receipt authentication and source policy validation, and moves
//! with the product witness. It grants no appearance/caps/final-output proof.
use super::*;
use super::removal_source::{body, covers, refused, relationships};
use super::super::model_context::ProductionContextId;

pub(super) struct AuthenticatedRemoval {
    context: ProductionContextId,
    product: u32,
    outputs: Vec<LogicalRetainedSlot>,
}
impl AuthenticatedRemoval {
    pub(super) fn validate(&self, context: ProductionContextId, plan: &RetainedProductPlan)
        -> Result<(), RetainedExecutionError> {
        let completion = plan.opening_completion.as_ref().ok_or_else(refused)?;
        if self.context != context || self.product != completion.product()
            || self.outputs.len() != plan.values.len() || self.outputs.is_empty()
            || self.outputs.iter().zip(&plan.values).any(|(slot, value)| *slot != value.slot() || !value.is_empty()) {
            return Err(protocol("foreign terminal opening removal"));
        }
        Ok(())
    }
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    /// Reports a provisional source-protected removal, never final publication.
    pub fn has_authenticated_opening_removal(&self) -> bool {
        self.removal.is_some() && self.validate_witness().is_ok()
    }
    pub(super) fn authenticate_removal(&mut self, plan: &RetainedProductPlan,
        decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<(), RetainedExecutionError> {
        if plan.opening_completion.is_none() || !plan.values.iter().all(LogicalRetainedValue::is_empty) {
            return Ok(());
        }
        self.validate(decoder, router)?;
        let context = self.context;
        let product = self.state.job.id;
        // Source obligations run under the original owner, acknowledging only
        // these decodes. Refusal poisons the whole continuation in traversal.rs.
        let (proof, _) = self.owner.work(decoder, router, |decoder, router| {
            prove(context, product, plan, decoder, router)
        }).map_err(protocol)?;
        self.removal = Some(proof?);
        Ok(())
    }
}
fn source_id(value: &LogicalRetainedValue, context: &OwnedMeshProductionContext, product: u32,
    decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<u32, RetainedExecutionError> {
    let LogicalRetainedDefinition::Source { source_epoch, source_revision, source_id, .. } = value.definition()
        else { return Err(refused()); };
    if (*source_epoch, *source_revision) != context.lifecycle().epoch_revision()
        || !value.is_product_placed() || value.placements().len() != 1
        || value.placements()[0].stage != (RetainedPlacementStage::Product { product_id: product }) {
        return Err(refused());
    }
    let entity = decoder.decode_by_id(product).map_err(|_| RetainedExecutionError::Source)?;
    let placement = router.resolve_scaled_placement_strict(&entity, decoder).map_err(geometry)?;
    let scale = nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(router.unit_scale()));
    let expected = placement * scale;
    let actual = value.world_from_source().ok_or_else(refused)?;
    if !actual.iter().zip(expected.as_slice()).all(|(a,b)| a.is_finite() && a.to_bits() == b.to_bits()) {
        return Err(refused());
    }
    Ok(*source_id)
}
fn prove(context: &OwnedMeshProductionContext, product: u32, plan: &RetainedProductPlan,
    decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<AuthenticatedRemoval, RetainedExecutionError> {
    context.validate_decoder(decoder).map_err(|_| RetainedExecutionError::Source)?;
    let completion = plan.opening_completion.as_ref().ok_or_else(refused)?;
    if completion.product() != product || completion.empty_host() || plan.values.is_empty() { return Err(refused()); }
    let relationships = relationships(context, decoder, product)?;
    if relationships.len() != completion.related_openings() { return Err(refused()); }
    let hosts = body(decoder, product)?;
    if hosts.len() != plan.values.len() { return Err(refused()); }
    let mut outputs = Vec::new();
    OwnedResourceContext::capture_current().reserve_headers(&mut outputs, hosts.len())
        .map_err(RetainedExecutionError::Stopped)?.retain();
    for (ordinal, final_value) in plan.values.iter().enumerate() {
        resource::charge(resource::Cost { work: completion.cuts().len() as u64 + 1, ..Default::default() })
            .map_err(RetainedExecutionError::Stopped)?.retain();
        let killing = completion.cuts().iter().find(|cut| cut.output().slot() == final_value.slot())
            .ok_or_else(refused)?;
        let mut chain = completion.cuts().iter().filter(|cut| cut.host_part == killing.host_part);
        let first = chain.next().ok_or_else(refused)?;
        let host = &first.inputs()[0];
        if host.slot() != first.host_part || host.is_empty()
            || source_id(host, context, product, decoder, router)? != hosts[ordinal] { return Err(refused()); }
        let mut previous = host;
        for cut in std::iter::once(first).chain(chain) {
            if cut.product != product || relationships.get(cut.opening_ordinal) != Some(&cut.requested_opening)
                || cut.inputs()[0] != *previous || previous.is_empty() { return Err(refused()); }
            previous = cut.output();
        }
        if previous != final_value || !killing.output().is_empty() { return Err(refused()); }
        let cutter = &killing.inputs()[1];
        let cutter_id = source_id(cutter, context, killing.requested_opening, decoder, router)?;
        let cutters = body(decoder, killing.requested_opening)?;
        if cutters.get(killing.cutter_ordinal) != Some(&cutter_id)
            || host.world_from_source() != cutter.world_from_source()
            || !covers(decoder, hosts[ordinal], cutter_id)? { return Err(refused()); }
        outputs.push(final_value.slot());
    }
    Ok(AuthenticatedRemoval { context: context.id(), product, outputs })
}
