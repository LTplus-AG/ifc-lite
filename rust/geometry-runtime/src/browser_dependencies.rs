// SPDX-License-Identifier: MPL-2.0
//! Sealed browser numerical dependencies. No caller can mint an object lease.
use super::{BrowserRealization, Owner};
use crate::RetainedLineage;
use ifc_lite_geometry::document::{BooleanOperation, RetainedRefusal, RetainedTessellation};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

/// Identity of one actual object, independent of SDK wire-slot reuse. Cloning
/// this identity grants no lease and cannot construct a numerical dependency.
#[derive(Debug, Clone)]
pub struct BrowserObjectHandle(Arc<()>);
impl PartialEq for BrowserObjectHandle {
    fn eq(&self, other: &Self) -> bool { Arc::ptr_eq(&self.0, &other.0) }
}
impl Eq for BrowserObjectHandle {}
impl BrowserObjectHandle {
    #[cfg(target_arch = "wasm32")]
    pub(super) fn new() -> Self { Self(Arc::new(())) }
}

pub enum BrowserDependency<'a> {
    Source { realization: &'a BrowserRealization, world_from_source: [f64; 16] },
    Result(&'a BrowserDependencyResult),
    Clip(&'a super::BrowserPlaneClip),
    /// Absolute proper-rigid occurrence frame for an unchanged sealed clip.
    PlacedClip { clip: &'a super::BrowserPlaneClip, world_from_clip: [f64;16] },
    /// Explicit replacement frame for this occurrence, never multiplied by the
    /// result's original world frame. The sealed object and result stay intact.
    PlacedResult { result: &'a BrowserDependencyResult, world_from_result: [f64;16] },
    Affine { copy: &'a super::BrowserAffineCopy, world_from_affine: [f64;16] },
}

/// The runtime seals the operands and frames it actually used. Processing must
/// compare against its independently captured issuance before consuming either.
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserOperationIdentity {
    pub left: BrowserObjectHandle,
    pub right: BrowserObjectHandle,
    pub operation: BooleanOperation,
    pub left_world_from_evaluation: [f64; 16],
    pub right_world_from_evaluation: [f64; 16],
}

pub struct BrowserDependencyResult {
    owner: Arc<Owner>,
    handle: BrowserObjectHandle,
    object_live: AtomicBool,
    #[cfg(target_arch = "wasm32")]
    object: wasm_bindgen::JsValue,
    outcome: crate::NumericalOutcome,
    mesh: RetainedTessellation,
    world_from_evaluation: [f64; 16],
    lineage: Arc<RetainedLineage>,
    #[cfg(target_arch = "wasm32")]
    operations: usize,
    identity: BrowserOperationIdentity,
}
impl BrowserDependencyResult {
    pub fn belongs_to(&self, domain: &super::BrowserCancellation) -> bool { Arc::ptr_eq(&self.owner, &domain.owner) }

    pub fn handle(&self) -> &BrowserObjectHandle { &self.handle }
    pub fn outcome(&self) -> crate::NumericalOutcome { self.outcome }
    pub fn is_empty(&self) -> bool { self.outcome == crate::NumericalOutcome::Empty }
    #[cfg(target_arch="wasm32")]
    pub(super) fn transform_parts(&self) -> Result<super::affine::TransformParts,RetainedRefusal> {
        self.validate_live()?;
        Ok(super::affine::TransformParts { owner:self.owner.clone(),object:self.object.clone(),
            handle:self.handle.clone(),lineage:self.lineage.clone(),operations:self.operations })
    }
    pub fn mesh(&self) -> &RetainedTessellation { &self.mesh }
    pub fn world_from_evaluation(&self) -> &[f64; 16] { &self.world_from_evaluation }
    pub fn lineage(&self) -> &RetainedLineage { &self.lineage }
    pub fn operation_identity(&self) -> &BrowserOperationIdentity { &self.identity }
    pub fn incarnation(&self) -> u64 { self.owner.identity }
    pub fn validate_live(&self) -> Result<(), RetainedRefusal> {
        self.owner.validate()?;
        if !self.object_live.load(Ordering::Acquire) { return Err(RetainedRefusal::InvalidRuntime); }
        #[cfg(target_arch = "wasm32")]
        if !self.owner.driver.object_live(&self.object) { return Err(RetainedRefusal::InvalidRuntime); }
        Ok(())
    }
}
impl Drop for BrowserDependencyResult {
    fn drop(&mut self) {
        self.object_live.store(false, Ordering::Release);
        #[cfg(target_arch = "wasm32")]
        self.owner.driver.release_object(&self.object);
    }
}

#[cfg(target_arch = "wasm32")]
pub(super) struct Input {
    pub(super) owner: Arc<Owner>,
    pub(super) object: wasm_bindgen::JsValue,
    pub(super) handle: BrowserObjectHandle,
    pub(super) frame: [f64; 16],
    pub(super) lineage: Arc<RetainedLineage>,
    pub(super) operations: usize,
}
#[cfg(target_arch = "wasm32")]
impl BrowserDependency<'_> {
    pub(super) fn input(&self) -> Result<Input, RetainedRefusal> {
        let input = match self {
            Self::Source { realization, world_from_source } => {
                realization.validate_live()?;
                Input { owner: realization.owner.clone(), object: realization.object.clone(),
                    handle: realization.handle.clone(), operations: 0,
                    frame: crate::retained_values::multiply(*world_from_source,
                        realization.completion.source_from_evaluation),
                    lineage: Arc::new(RetainedLineage::Source {
                        request: Box::new(realization.completion.request().clone()),
                        world_from_source: *world_from_source }) }
            }
            Self::Affine { copy, world_from_affine } => {
                let parts=copy.transform_parts()?;
                Input { owner:parts.owner,object:parts.object,handle:parts.handle,operations:parts.operations,
                    frame:*world_from_affine,lineage:Arc::new(RetainedLineage::Placed {
                        value:parts.lineage,world_from_evaluation:*world_from_affine }) }
            }
            Self::Clip(clip) => clip.dependency_parts()?,
            Self::PlacedClip {clip,world_from_clip} => {
                let mut input=clip.dependency_parts()?;
                input.frame=*world_from_clip;
                input.lineage=Arc::new(RetainedLineage::Placed {value:input.lineage,
                    world_from_evaluation:*world_from_clip});
                input
            }
            Self::Result(result) => {
                result.validate_live()?;
                Input { owner: result.owner.clone(), object: result.object.clone(), handle: result.handle.clone(),
                    frame: result.world_from_evaluation, lineage: result.lineage.clone(), operations: result.operations }
            }
            Self::PlacedResult {result,world_from_result} => {
                result.validate_live()?;
                Input {owner:result.owner.clone(),object:result.object.clone(),handle:result.handle.clone(),
                    frame:*world_from_result,operations:result.operations,
                    lineage:Arc::new(RetainedLineage::Placed {value:result.lineage.clone(),
                        world_from_evaluation:*world_from_result})}
            }
        };
        crate::retained_values::rigid(input.frame).map_err(|e| RetainedRefusal::UnsupportedSource(e.into()))?;
        Ok(input)
    }
}

#[cfg(target_arch = "wasm32")]
impl super::BrowserWorker {
    /// Executes immutable ordered operands in the left f64 evaluation frame.
    /// Openings use Difference here. This confers no final-product coverage.
    pub async fn evaluate_retained_boolean(&mut self, left: BrowserDependency<'_>, right: BrowserDependency<'_>,
        operation: BooleanOperation, chord: f64, angle: f64, max_bytes: u32)
        -> Result<BrowserDependencyResult, wasm_bindgen::JsValue>
    {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        let error = |e: RetainedRefusal| JsValue::from_str(&e.to_string());
        self.owner.validate().map_err(error)?;
        if !self.owner.independent_leases { return Err(error(RetainedRefusal::Contract)); }
        let left = left.input().map_err(error)?;
        let right = right.input().map_err(error)?;
        // Foreign rejection is before arming cancellation, without touching
        // either foreign worker. Integers alone do not establish ownership.
        if !Arc::ptr_eq(&self.owner, &left.owner) || !Arc::ptr_eq(&self.owner, &right.owner) {
            return Err(error(RetainedRefusal::InvalidRuntime));
        }
        if !self.qualified { return Err(error(RetainedRefusal::UnqualifiedRegion)); }
        let operations = left.operations.checked_add(right.operations).and_then(|n| n.checked_add(1))
            .filter(|n| *n <= 128).ok_or_else(|| JsValue::from_str("retained dependency depth/work"))?;
        let relative = crate::retained_values::relative(left.frame, right.frame).map_err(JsValue::from_str)?;
        super::evaluation_limits(chord, angle, max_bytes).map_err(error)?;
        let code = match operation { BooleanOperation::Union => 1, BooleanOperation::Intersection => 2, BooleanOperation::Difference => 3 };
        let mut flight = super::InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.evaluate_boolean(&left.object, &right.object,
            &relative, code, chord, angle, max_bytes)).await?;
        self.owner.validate().map_err(error)?;
        let object = js_sys::Reflect::get(&value, &JsValue::from_str("object"))?;
        if !self.owner.driver.object_live(&object) { return Err(error(RetainedRefusal::InvalidRuntime)); }
        let mesh = super::bridge::mesh(&value)?;
        let outcome = super::bridge::outcome(&value, &mesh)?;
        let result = BrowserDependencyResult {
            owner: self.owner.clone(), handle: BrowserObjectHandle::new(), object,
            object_live: AtomicBool::new(true), mesh, outcome,
            world_from_evaluation: left.frame, operations,
            lineage: Arc::new(RetainedLineage::Boolean { operation, left: left.lineage, right: right.lineage }),
            identity: BrowserOperationIdentity { left: left.handle, right: right.handle, operation,
                left_world_from_evaluation: left.frame, right_world_from_evaluation: right.frame },
        };
        result.validate_live().map_err(error)?;
        flight.disarm();
        Ok(result)
    }
}
