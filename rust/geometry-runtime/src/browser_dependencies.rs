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
    mesh: RetainedTessellation,
    world_from_evaluation: [f64; 16],
    lineage: Arc<RetainedLineage>,
    #[cfg(target_arch = "wasm32")]
    operations: usize,
    identity: BrowserOperationIdentity,
}
impl BrowserDependencyResult {
    pub fn handle(&self) -> &BrowserObjectHandle { &self.handle }
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
struct Input {
    owner: Arc<Owner>,
    object: wasm_bindgen::JsValue,
    handle: BrowserObjectHandle,
    frame: [f64; 16],
    lineage: Arc<RetainedLineage>,
    operations: usize,
}
#[cfg(target_arch = "wasm32")]
impl BrowserDependency<'_> {
    fn input(&self) -> Result<Input, RetainedRefusal> {
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
            Self::Result(result) => {
                result.validate_live()?;
                Input { owner: result.owner.clone(), object: result.object.clone(), handle: result.handle.clone(),
                    frame: result.world_from_evaluation, lineage: result.lineage.clone(), operations: result.operations }
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
        if !chord.is_finite() || chord <= 0. || !angle.is_finite() || angle <= 0. || max_bytes == 0 {
            return Err(error(RetainedRefusal::InvalidSource("invalid retained evaluation limits")));
        }
        let code = match operation { BooleanOperation::Union => 1, BooleanOperation::Intersection => 2, BooleanOperation::Difference => 3 };
        let mut flight = super::InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.evaluate_boolean(&left.object, &right.object,
            &relative, code, chord, angle, max_bytes)).await?;
        self.owner.validate().map_err(error)?;
        let object = js_sys::Reflect::get(&value, &JsValue::from_str("object"))?;
        if !self.owner.driver.object_live(&object) { return Err(error(RetainedRefusal::InvalidRuntime)); }
        let result = BrowserDependencyResult {
            owner: self.owner.clone(), handle: BrowserObjectHandle::new(), object,
            object_live: AtomicBool::new(true), mesh: super::bridge::mesh(&value)?,
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
