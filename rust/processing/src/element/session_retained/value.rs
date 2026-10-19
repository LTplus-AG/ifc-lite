// SPDX-License-Identifier: MPL-2.0
//! Sealed target-selected objects owned by the processing transaction, never geometry.
use super::*;
use super::target::{ObjectIdentity as BrepHandle, AffineReceipt as RetainedAffineCopy, Dependency as RetainedDependency,
    BooleanReceipt as RetainedDependencyResult, ClipReceipt, TransformInput as RetainedTransformInput, Domain, ReceiptError as WorkerError};

pub(super) enum RealizationKind {
    Construction(Box<RetainedRealization>),
    UnaryClip(Box<ClipReceipt>),
    Affine(Box<RetainedAffineCopy>),
    Boolean(Box<RetainedDependencyResult>),
}
pub struct CommonRetainedRealization {
    kind: RealizationKind,
    // The charged shared header can outlive its issuing execution. Its account
    // remains owned until the final receipt/reference is destroyed.
    _resources: OwnedResourceContext,
}
impl std::fmt::Debug for CommonRetainedRealization {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommonRetainedRealization").field("solid",&self.solid()).finish()
    }
}
impl CommonRetainedRealization {
    pub(super) fn header_bytes() -> u64 {
        (std::mem::size_of::<RetainedRealization>().max(std::mem::size_of::<RetainedAffineCopy>())
            .max(std::mem::size_of::<RetainedDependencyResult>()).max(std::mem::size_of::<ClipReceipt>())
            +std::mem::size_of::<Self>()+2*std::mem::size_of::<usize>()) as u64
    }
    pub(super) fn new(kind:RealizationKind,resources:OwnedResourceContext) -> Self {Self {kind,_resources:resources}}
    pub(super) fn kind(&self) -> &RealizationKind {&self.kind}

    #[cfg(not(target_arch = "wasm32"))]
    pub fn solid(&self) -> BrepHandle {
        match &self.kind { RealizationKind::UnaryClip(v)=>v.solid(), RealizationKind::Construction(v)=>v.solid(), RealizationKind::Affine(v)=>v.solid(), RealizationKind::Boolean(v)=>v.solid() }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub fn owner(&self) -> &Domain {
        match &self.kind { RealizationKind::UnaryClip(v)=>v.owner(), RealizationKind::Construction(v)=>v.owner(), RealizationKind::Affine(v)=>v.owner(), RealizationKind::Boolean(v)=>v.owner() }
    }
    #[cfg(target_arch = "wasm32")]
    pub fn solid(&self) -> BrepHandle {
        match &self.kind { RealizationKind::UnaryClip(v)=>v.handle().clone(), RealizationKind::Construction(v)=>v.handle().clone(), RealizationKind::Affine(v)=>v.handle().clone(), RealizationKind::Boolean(v)=>v.handle().clone() }
    }
    pub(super) fn belongs_to(&self, domain: &Domain) -> bool {
        match &self.kind { RealizationKind::UnaryClip(v)=>target::clip_belongs(v,domain),
            RealizationKind::Construction(v)=>target::construction_belongs(v,domain),
            RealizationKind::Affine(v)=>target::affine_belongs(v,domain), RealizationKind::Boolean(v)=>target::boolean_belongs(v,domain) }
    }
    pub fn validate_live(&self) -> Result<(), WorkerError> {
        match &self.kind { RealizationKind::UnaryClip(v)=>v.validate_live(), RealizationKind::Construction(v)=>v.validate_live(), RealizationKind::Affine(v)=>v.validate_live(), RealizationKind::Boolean(v)=>v.validate_live() }
    }
    pub fn construction(&self) -> Option<&RetainedRealization> {
        match &self.kind { RealizationKind::Construction(v)=>Some(v), _=>None }
    }
    pub(super) fn transform_input(&self) -> RetainedTransformInput<'_> {
        match &self.kind { RealizationKind::UnaryClip(v)=>RetainedTransformInput::Clip(v),
            RealizationKind::Construction(v)=>RetainedTransformInput::Source(v),
            RealizationKind::Affine(v)=>RetainedTransformInput::Affine(v), RealizationKind::Boolean(v)=>RetainedTransformInput::Result(v) }
    }
    pub(super) fn dependency(&self, value: &ifc_lite_geometry::program::LogicalRetainedValue)
        -> Result<RetainedDependency<'_>, RetainedExecutionError> {
        let frame = *value.object_frame();
        Ok(match &self.kind {
            RealizationKind::Construction(v) => {
                RetainedDependency::Source { realization: v,
                    world_from_source: *value.world_from_source().ok_or_else(||protocol("construction input requires source identity"))? }
            }
            RealizationKind::UnaryClip(v) if v.world_from_evaluation()==&frame=>RetainedDependency::Clip(v),
            RealizationKind::UnaryClip(v)=>RetainedDependency::PlacedClip {clip:v,world_from_clip:frame},
            RealizationKind::Affine(v)=>RetainedDependency::Affine {copy:v,world_from_affine:frame},
            RealizationKind::Boolean(v) if v.world_from_evaluation() == &frame => RetainedDependency::Result(v),
            RealizationKind::Boolean(v)=>RetainedDependency::PlacedResult {result:v,world_from_result:frame},
        })
    }
}
