// SPDX-License-Identifier: MPL-2.0
//! Strict source admission for J3. These bindings are obligations, not cuts.
//! The display index intentionally drops invalid/thin layers and has no source
//! ids. It therefore cannot authenticate a retained material partition.
use super::*;
use ifc_lite_core::{AttributeValue, DecodedEntity, IfcType};
use ifc_lite_geometry::material_layer_index::LayerAxis;
mod index;
mod source;
#[cfg(test)]
mod tests;
pub(crate) use index::LayerAssociationIndex;

/// A scalar offset is measured against this reference. Wall offsets follow
/// the Axis curve; they must never be silently interpreted as global Y planes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetainedLayerReference {
    ProductAxis(LayerAxis),
    WallAxis { representation_id: u32, curve_id: u32 },
}
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedLayerBand {
    pub layer_id: u32,
    /// None is an authored air gap; a dangling reference is an error.
    pub material_id: Option<u32>,
    pub ordinal: usize,
    pub thickness_metres: f64,
    /// Signed source-reference offsets, in metres, in authored layer order.
    pub start_metres: f64,
    pub end_metres: f64,
}
/// Deliberately distinct from source IFC faces. A boundary id identifies a
/// future cut obligation, and DOES NOT certify any SDK face as a generated cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedLayerInterface {
    pub usage_id: u32,
    pub before_band: usize,
    pub after_band: usize,
}
#[derive(Debug)]
pub struct RetainedLayerSource {
    context: super::super::model_context::ProductionContextId,
    product: u32,
    association: u32,
    usage: u32,
    layer_set: u32,
    axis: LayerAxis,
    direction: f64,
    unit_scale: f64,
    reference: RetainedLayerReference,
    bands: Vec<RetainedLayerBand>,
    interfaces: Vec<RetainedLayerInterface>,
    /// Product-local metres -> world metres, from the canonical placement
    /// service. RTC is presentation-only and is not baked into layer offsets.
    world_from_product: [f64; 16],
}
impl RetainedLayerSource {
    pub fn product(&self) -> u32 { self.product }
    pub fn association(&self) -> u32 { self.association }
    pub fn usage(&self) -> u32 { self.usage }
    pub fn layer_set(&self) -> u32 { self.layer_set }
    pub fn axis(&self) -> LayerAxis { self.axis }
    pub fn direction_sense(&self) -> f64 { self.direction }
    pub fn length_unit_scale(&self) -> f64 { self.unit_scale }
    pub fn reference(&self) -> &RetainedLayerReference { &self.reference }
    pub fn bands(&self) -> &[RetainedLayerBand] { &self.bands }
    pub fn interfaces(&self) -> &[RetainedLayerInterface] { &self.interfaces }
    pub fn world_from_product(&self) -> &[f64; 16] { &self.world_from_product }
    pub(super) fn validate(&self, context: &OwnedMeshProductionContext, product: u32)
        -> Result<(), RetainedExecutionError> {
        context.validate_source().map_err(|_| RetainedExecutionError::Source)?;
        if self.context != context.id() || self.product != product {
            return Err(RetainedExecutionError::Source);
        }
        Ok(())
    }
}
fn invalid() -> RetainedExecutionError { RetainedExecutionError::Source }
fn charge(work: usize) -> Result<(), RetainedExecutionError> {
    resource::charge(resource::Cost { work: work as u64, ..Default::default() })
        .map_err(RetainedExecutionError::Stopped)?.retain();
    Ok(())
}
fn reserve<T>(values: &mut Vec<T>, count: usize) -> Result<(), RetainedExecutionError> {
    resource::reserve_headers(values, count).map_err(RetainedExecutionError::Stopped)?.retain();
    Ok(())
}
fn reference_id(value: &AttributeValue) -> Result<u32, RetainedExecutionError> {
    value.as_entity_ref().ok_or_else(invalid)
}
fn decode(decoder: &mut EntityDecoder, id: u32) -> Result<DecodedEntity, RetainedExecutionError> {
    charge(1)?;
    decoder.decode_by_id(id).map_err(|_| invalid())
}

pub(super) fn capture(context: &OwnedMeshProductionContext, product: &DecodedEntity,
    decoder: &mut EntityDecoder, router: &GeometryRouter)
    -> Result<Option<Arc<RetainedLayerSource>>, RetainedExecutionError> {
    context.validate_decoder(decoder).map_err(|_| invalid())?;
    let index = index::get(context, decoder)?;
    let mut selected = None;
    for &id in index.for_product(product.id) {
        let association = decode(decoder, id)?;
        let usage = decode(decoder, association.get_ref(5).ok_or_else(invalid)?)?;
        if !usage.ifc_type.is_subtype_of(IfcType::IfcMaterialLayerSetUsage) { continue; }
        if usage.ifc_type != IfcType::IfcMaterialLayerSetUsage { return Err(invalid()); }
        // Multiple usages have no unique occurrence binding. Never use the
        // display index's first-wins policy as geometric authority.
        if selected.is_some() { return Err(invalid()); }
        selected = Some(source::capture(context, product, id, &usage, decoder, router)?);
    }
    selected.map(|value| {
        resource::charge(resource::Cost { live_bytes: std::mem::size_of::<RetainedLayerSource>() as u64,
            ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
        Ok(Arc::new(value))
    }).transpose()
}
