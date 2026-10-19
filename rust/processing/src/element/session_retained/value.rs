// SPDX-License-Identifier: MPL-2.0
//! Sealed native objects owned by the processing transaction, never geometry.
use super::*;
use ifc_lite_geometry_runtime::{BrepHandle, RetainedAffineCopy, RetainedDependency,
    RetainedDependencyResult, RetainedTransformInput, RuntimeOwner, WorkerError};

#[derive(Debug)]
pub(super) enum RealizationKind {
    Construction(Box<RetainedRealization>),
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
            .max(std::mem::size_of::<RetainedDependencyResult>())
            +std::mem::size_of::<Self>()+2*std::mem::size_of::<usize>()) as u64
    }
    pub(super) fn new(kind:RealizationKind,resources:OwnedResourceContext) -> Self {Self {kind,_resources:resources}}
    pub(super) fn kind(&self) -> &RealizationKind {&self.kind}

    pub fn solid(&self) -> BrepHandle {
        match &self.kind { RealizationKind::Construction(v)=>v.solid(), RealizationKind::Affine(v)=>v.solid(), RealizationKind::Boolean(v)=>v.solid() }
    }
    pub fn owner(&self) -> &RuntimeOwner {
        match &self.kind { RealizationKind::Construction(v)=>v.owner(), RealizationKind::Affine(v)=>v.owner(), RealizationKind::Boolean(v)=>v.owner() }
    }
    pub fn validate_live(&self) -> Result<(), WorkerError> {
        match &self.kind { RealizationKind::Construction(v)=>v.validate_live(), RealizationKind::Affine(v)=>v.validate_live(), RealizationKind::Boolean(v)=>v.validate_live() }
    }
    pub fn construction(&self) -> Option<&RetainedRealization> {
        match &self.kind { RealizationKind::Construction(v)=>Some(v), _=>None }
    }
    pub(super) fn transform_input(&self) -> RetainedTransformInput<'_> {
        match &self.kind { RealizationKind::Construction(v)=>RetainedTransformInput::Source(v),
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
            RealizationKind::Affine(v)=>RetainedDependency::Affine {copy:v,world_from_affine:frame},
            RealizationKind::Boolean(v) if v.world_from_evaluation() == &frame => RetainedDependency::Result(v),
            RealizationKind::Boolean(_)=>return Err(protocol("Boolean result frame requires explicit affine operation")),
        })
    }
}
