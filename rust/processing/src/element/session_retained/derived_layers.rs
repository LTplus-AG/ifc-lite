// SPDX-License-Identifier: MPL-2.0
//! Source-bound J3 issuance, independent of authored Boolean/plane ancestry.
use super::*;
use ifc_lite_core::slot;
use ifc_lite_geometry::{analytic::DerivedLayerRegions, document::DerivedLayerRegion};
use runtime::{Invocation, NumericalLimits, Operand, ReceiptEvidence};
mod execution;
#[cfg(test)]
mod tests;
#[cfg(all(test,feature="retained-native",not(target_arch="wasm32")))]
mod runtime_tests;

/// A boundary is shared by consecutive bands; each uses its complementary
/// side. These ordinals are material interfaces, NOT persistent face ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterialInterfaceSide { TowardPreviousBand, TowardNextBand }
pub struct DerivedLayerBinding {
    source: Arc<RetainedLayerSource>,
    net_host: LogicalRetainedValue,
    epoch_revision: (u64,u64),
    ordinal: usize,
    frame: [f64;16],
}
impl DerivedLayerBinding {
    pub fn source(&self) -> &RetainedLayerSource { &self.source }
    pub fn net_host(&self) -> &LogicalRetainedValue { &self.net_host }
    pub fn epoch_revision(&self) -> (u64,u64) { self.epoch_revision }
    pub fn ordinal(&self) -> usize { self.ordinal }
    pub fn physical_frame(&self) -> &[f64;16] { &self.frame }
    pub fn boundaries(&self) -> [(usize,MaterialInterfaceSide);2] {
        [(self.ordinal,MaterialInterfaceSide::TowardNextBand),
         (self.ordinal+1,MaterialInterfaceSide::TowardPreviousBand)]
    }
}
struct RegionRequest {
    binding: DerivedLayerBinding,
    document: GeometryDocument,
    request: RetainedRequest,
    world_from_region: [f64;16],
}
pub(super) struct LayerToken { pub(super) stage: AtomicU8 }
pub struct DerivedLayersIssued<R: NumericalReceipt> {
    token: Arc<LayerToken>,
    host: BooleanInput<R>,
    regions: Vec<RegionRequest>,
    domain: R::Domain,
    lifecycle: ProductionLifecycle,
    owner_stamp: OwnerStamp,
    resources: OwnedResourceContext,
    armed: bool,
}
pub struct DerivedLayerBandResult<R: NumericalReceipt> {
    region: R,
    result: R,
    empty: bool,
}
impl<R: NumericalReceipt> DerivedLayerBandResult<R> {
    pub fn receipt(&self) -> &R { &self.result }
    pub fn is_empty(&self) -> bool { self.empty }
}
pub struct DerivedLayersCompleted<R: NumericalReceipt> {
    issued: DerivedLayersIssued<R>,
    bands: Vec<DerivedLayerBandResult<R>>,
}
/// All bands become visible together only after source and receipt revalidation.
/// Capped intermediate geometry; final appearance/face publication is refused.
pub struct DerivedLayerManifest<R: NumericalReceipt> {
    completed: DerivedLayersCompleted<R>,
}
impl<R: NumericalReceipt> DerivedLayerManifest<R> {
    pub fn bands(&self) -> &[DerivedLayerBandResult<R>] { &self.completed.bands }
    pub fn binding(&self, ordinal: usize) -> Option<&DerivedLayerBinding> {
        self.completed.issued.regions.get(ordinal).map(|r| &r.binding)
    }
    pub fn validate(&self) -> Result<(),RetainedExecutionError> { self.completed.validate() }
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_,R> {
    pub fn issue_layer_partition(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter,
        worker: &impl RetainedRuntime<Receipt=R>) -> Result<DerivedLayersIssued<R>,RetainedExecutionError> {
        self.validate(decoder,router)?;
        self.validate_witness()?;
        if self.layer_token.is_some() || self.layer_manifest.is_some() { return Err(protocol("J3 already issued")); }
        let source = self.layer_source.clone().ok_or(RetainedExecutionError::Unsupported("no layer usage"))?;
        source.validate(self.context,self.state.job.id)?;
        let plan = self.plan.as_ref().ok_or_else(|| protocol("J3 missing net host"))?;
        if plan.remaining.contains(&RetainedRequirement::OpeningClosure) || plan.values.len()!=1 {
            return Err(RetainedExecutionError::Unsupported("J3 requires authenticated single net host"));
        }
        let net = plan.values[0].try_copy().map_err(geometry)?;
        let host = BooleanInput::new(self.input(&net)?,&net)?;
        if host.realization.is_empty() { return Err(RetainedExecutionError::Unsupported("J3 whole-removal policy unproved")); }
        if !host.realization.kind.belongs_to_domain(&worker.domain()) { return Err(protocol("J3 foreign worker")); }
        let resources = self.resources.clone();
        let (proof,owner_stamp) = resources.with_scope(|| self.owner.work(decoder,router,|decoder,_| {
            capture_regions(&source,self.state.job.entity,decoder)
        })).map_err(protocol)?;
        let proof = Arc::new(proof?);
        let mut regions = Vec::new();
        resources.reserve_headers(&mut regions,source.bands().len()).map_err(RetainedExecutionError::Stopped)?.retain();
        for ordinal in 0..source.bands().len() {
            let region_request = resources.with_scope(|| {
            resource::charge(resource::Cost { live_bytes:4096,work:1,..Default::default() })
                .map_err(RetainedExecutionError::Stopped)?.retain();
            let mut document = GeometryDocument::new();
            let region = DerivedLayerRegion::new(proof.clone(),ordinal).map_err(protocol)?;
            let handle = document.add_derived_layer_region(region).map_err(protocol)?;
            let request = document.prepare_retained(handle,worker.incarnation()).map_err(protocol)?;
            // Derived encoding is in raw product-local units. Unit conversion
            // is explicit and occurs once, before the canonical product frame.
            let scale = nalgebra::Matrix4::new_scaling(source.length_unit_scale());
            let world = nalgebra::Matrix4::from_column_slice(source.world_from_product()) * scale;
            let world_from_region = ifc_lite_geometry::math::mat4::col_major_array(&world);
            Ok::<_,RetainedExecutionError>(RegionRequest { binding: DerivedLayerBinding { source:source.clone(),
                net_host:net.try_copy().map_err(geometry)?,epoch_revision:self.context.lifecycle().epoch_revision(),
                ordinal,frame:host.frame }, document, request, world_from_region })
            })?;
            regions.push(region_request);
        }
        let token = Arc::new(LayerToken { stage:AtomicU8::new(ISSUED) });
        self.layer_token = Some(token.clone());
        Ok(DerivedLayersIssued { token,host,regions,domain:worker.domain(),
            lifecycle:self.context.lifecycle(),owner_stamp,resources,armed:true })
    }
    pub fn accept_layer_partition(&mut self, completed: DerivedLayersCompleted<R>,
        decoder: &EntityDecoder, router: &GeometryRouter) -> Result<(),RetainedExecutionError> {
        let owner_stamp = self.validate(decoder,router)?;
        if owner_stamp != completed.issued.owner_stamp { return Err(protocol("J3_AUTHORITY: source owner epoch")); }
        let token = self.layer_token.as_ref().ok_or_else(|| protocol("J3 no issuance"))?;
        if !Arc::ptr_eq(token,&completed.issued.token) { return Err(protocol("J3_AUTHORITY: foreign issuance")); }
        completed.validate()?;
        let source = self.layer_source.as_ref().ok_or_else(|| protocol("J3 missing source"))?;
        source.validate(self.context,self.state.job.id)?;
        let plan = self.plan.as_ref().ok_or_else(|| protocol("J3 missing plan"))?;
        for region in &completed.issued.regions {
            if !Arc::ptr_eq(source,&region.binding.source)
                || region.binding.epoch_revision != self.context.lifecycle().epoch_revision()
                || plan.values.len()!=1 || plan.values[0] != region.binding.net_host {
                return Err(protocol("J3_AUTHORITY: source/net-host generation"));
            }
        }
        token.stage.compare_exchange(DELIVERED,ACCEPTED,Ordering::AcqRel,Ordering::Acquire)
            .map_err(|_|protocol("J3 cancelled or replayed completion"))?;
        // No fallible work after this point. Preserve original J2 host/ledger;
        // the complete ordered band manifest is an additional sealed result.
        self.layer_manifest = Some(DerivedLayerManifest { completed });
        if let Some(plan) = &mut self.plan { plan.remaining.retain(|r| *r != RetainedRequirement::MaterialLayers); }
        Ok(())
    }
}
fn capture_regions(source: &RetainedLayerSource, product: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder) -> Result<DerivedLayerRegions,RetainedExecutionError> {
    let RetainedLayerReference::WallAxis { curve_id,.. } = source.reference() else {
        return Err(RetainedExecutionError::Unsupported("J3 unproved noncircular layer family"));
    };
    let shape = decoder.decode_by_id(product.get_ref(ifc_lite_core::slot::IfcProduct::REPRESENTATION.index())
        .ok_or(RetainedExecutionError::Source)?).map_err(protocol)?;
    let mut body = None;
    for item in shape.get_list(slot::IfcProductDefinitionShape::REPRESENTATIONS.index()).ok_or(RetainedExecutionError::Source)? {
        resource::charge(resource::Cost { work:1,..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
        let rep = decoder.decode_by_id(item.as_entity_ref().ok_or(RetainedExecutionError::Source)?).map_err(protocol)?;
        if rep.get_string(slot::IfcShapeRepresentation::REPRESENTATION_IDENTIFIER.index())!=Some("Body") { continue; }
        let items = rep.get_list(slot::IfcShapeRepresentation::ITEMS.index()).ok_or(RetainedExecutionError::Source)?;
        if body.is_some() || items.len()!=1 { return Err(RetainedExecutionError::Unsupported("J3 body coverage")); }
        body = Some(items[0].as_entity_ref().ok_or(RetainedExecutionError::Source)?);
    }
    let mut offsets = Vec::new();
    OwnedResourceContext::capture_current().reserve_headers(&mut offsets,source.bands().len()+1)
        .map_err(RetainedExecutionError::Stopped)?.retain();
    for band in source.bands() { offsets.push(band.start_metres); }
    offsets.push(source.bands().last().ok_or(RetainedExecutionError::Source)?.end_metres);
    DerivedLayerRegions::capture(body.ok_or(RetainedExecutionError::Source)?,*curve_id,
        &offsets,source.length_unit_scale(),decoder).map_err(protocol)
}
impl<R: NumericalReceipt> Drop for DerivedLayersIssued<R> {
    fn drop(&mut self) { if self.armed { self.domain.retire(); } }
}
