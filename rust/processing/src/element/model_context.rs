// SPDX-License-Identifier: MPL-2.0
//! Immutable model inputs shared once per effective batch, never copied per product.
use super::*;
use std::{fmt,sync::{Arc,atomic::{AtomicU64,Ordering}}};

/// Shared components selected by the existing consumer for one effective batch.
/// Construct by moving maps into Arcs or cloning existing model-level Arcs.
#[derive(Clone,Default)]
pub struct OwnedMeshProductionData {
    pub void_index:Arc<FxHashMap<u32,Vec<u32>>>,
    pub geometry_style_index:Arc<FxHashMap<u32,GeometryStyleInfo>>,
    pub indexed_colour_full:Arc<FxHashMap<u32,FullIndexedColourMap>>,
    pub element_material_colors:Arc<FxHashMap<u32,Vec<[f32;4]>>>,
    pub texture_index:Arc<FxHashMap<u32,ResolvedTextureMap>>,
    pub site_local_rotation:Option<Arc<Vec<f64>>>,
}

/// Process-local load, source epoch and immutable snapshot revision. This is
/// completion identity, not a content digest or a cross-worker network token.
#[derive(Debug,Clone,Copy,PartialEq,Eq,Hash)]
pub struct ProductionContextId {
    load:u64,
    source_epoch:u64,
    revision:u64,
}
struct ModelState {load:u64,source_epoch:AtomicU64,revision:AtomicU64}

/// Explicit source lifecycle. Dropping this handle does not invalidate snapshots.
#[derive(Clone)]
pub struct ProductionModel {state:Arc<ModelState>,source:Option<Arc<ifc_lite_core::SourceBundle>>,trusted:Option<ifc_lite_core::TrustedDecoderInputs>}
impl Default for ProductionModel {fn default()->Self {Self::new()}}
impl ProductionModel {
    /// Explicit compatibility mode for callers that retain borrowed bytes and
    /// independently supplied indexes. No source authentication is promised.
    pub fn new()->Self {
        static NEXT:AtomicU64=AtomicU64::new(1);
        let load=NEXT.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|n|n.checked_add(1))
            .expect("production model identity exhausted");
        Self {state:Arc::new(ModelState {load,source_epoch:AtomicU64::new(0),revision:AtomicU64::new(0)}),source:None,trusted:None}
    }
    /// Bind a model to immutable bytes and their canonically constructed index.
    pub fn from_source(source:Arc<ifc_lite_core::SourceBundle>)->Self {
        Self {source:Some(source),..Self::new()}
    }
    /// Explicit authoring/extension mode: authenticate the immutable base source,
    /// and accept this decoder's external input revision as trusted configuration.
    pub fn from_trusted_inputs(inputs:ifc_lite_core::TrustedDecoderInputs)->Self {
        Self {source:Some(inputs.source().clone()),trusted:Some(inputs),..Self::new()}
    }
    /// Capture the actual selected components. A later same-source snapshot
    /// never changes or expires this snapshot.
    pub fn snapshot(&self,data:OwnedMeshProductionData)->Arc<OwnedMeshProductionContext> {
        let source_epoch=self.state.source_epoch.load(Ordering::Acquire);
        let revision=self.state.revision.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|n|n.checked_add(1))
            .expect("production context revision exhausted")+1;
        Arc::new(OwnedMeshProductionContext {id:ProductionContextId {load:self.state.load,source_epoch,revision},
            data,state:self.state.clone(),source:self.source.clone(),trusted:self.trusted.clone()})
    }
    /// Whether a snapshot was created by this model load, independent of its
    /// immutable configuration revision. This grants no decoder authority.
    pub fn owns_snapshot(&self,context:&OwnedMeshProductionContext)->bool {
        self.state.load==context.id.load
    }
    /// Expire all snapshots tied to the preceding source/index bundle. Call at
    /// explicit source replacement; never infer an epoch from map addresses.
    pub fn invalidate_source(&self) {
        self.state.source_epoch.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|n.checked_add(1))
            .expect("production source epoch exhausted");
    }
}

/// Immutable model inputs owned by a resumable product from planning to publication.
pub struct OwnedMeshProductionContext {
    id:ProductionContextId,
    data:OwnedMeshProductionData,
    state:Arc<ModelState>,
    source:Option<Arc<ifc_lite_core::SourceBundle>>,
    trusted:Option<ifc_lite_core::TrustedDecoderInputs>,
}
impl OwnedMeshProductionContext {
    pub fn id(&self)->ProductionContextId {self.id}
    /// Numerical presentation retains only its immutable derived inputs, never
    /// the model/context authority or a future source bundle attached to it.
    pub(super) fn presentation_palettes(&self)->Arc<FxHashMap<u32,FullIndexedColourMap>> {
        Arc::clone(&self.data.indexed_colour_full)
    }
    pub(super) fn presentation_rotation(&self)->Option<Arc<Vec<f64>>> {
        self.data.site_local_rotation.clone()
    }
    pub fn validate_source(&self)->Result<(),ProductionContextError> {
        if self.id.source_epoch==self.state.source_epoch.load(Ordering::Acquire) {Ok(())}
        else {Err(ProductionContextError::StaleSource)}
    }
    /// None denotes the explicit borrowed compatibility contract: the caller
    /// must pair bytes/index itself. Lifecycle validity is not authentication.
    pub fn source(&self)->Option<&Arc<ifc_lite_core::SourceBundle>> {self.source.as_ref()}
    pub fn validate_decoder(&self,decoder:&EntityDecoder<'_>)->Result<(),ProductionContextError> {
        self.validate_source()?;
        if self.trusted.as_ref().map_or_else(|| self.source.as_ref().is_some_and(|source| !source.owns_decoder(decoder)), |inputs| !inputs.matches(decoder)) {
            return Err(ProductionContextError::MismatchedSource);
        }
        Ok(())
    }
    pub fn borrowed(&self)->MeshProductionContext<'_> {
        MeshProductionContext {void_index:&self.data.void_index,geometry_style_index:&self.data.geometry_style_index,
            indexed_colour_full:&self.data.indexed_colour_full,element_material_colors:&self.data.element_material_colors,
            texture_index:&self.data.texture_index,site_local_rotation:self.data.site_local_rotation.as_deref()}
    }
}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum ProductionContextError {StaleSource,MismatchedSource}
impl fmt::Display for ProductionContextError {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {f.write_str(match self {Self::StaleSource=>"production model source was invalidated", Self::MismatchedSource=>"decoder does not belong to the production source bundle"})}
}
impl std::error::Error for ProductionContextError {}
