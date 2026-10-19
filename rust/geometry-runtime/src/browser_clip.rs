// SPDX-License-Identifier: MPL-2.0
//! Immutable browser Clip values, issued only by the captured private driver.
use super::{BrowserObjectHandle, Owner};
use crate::{NumericalOutcome, PlaneCertificate, PlaneClipMode, PlaneSide, RetainedLineage};
use ifc_lite_geometry::document::{RetainedRefusal, RetainedTessellation};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

#[derive(Debug, Clone, PartialEq)]
pub struct BrowserPlaneClipIdentity {
    pub input: BrowserObjectHandle,
    pub output: BrowserObjectHandle,
    pub plane: [f64;6],
    pub side: PlaneSide,
    pub mode: PlaneClipMode,
    pub world_from_evaluation: [f64;16],
    /// Shared immutable evidence, also retained by the numerical lineage.
    pub certificate: Arc<PlaneCertificate>,
}
pub struct BrowserPlaneClip {
    owner: Arc<Owner>,
    handle: BrowserObjectHandle,
    live: AtomicBool,
    #[cfg(target_arch="wasm32")]
    object: wasm_bindgen::JsValue,
    identity: BrowserPlaneClipIdentity,
    lineage: Arc<RetainedLineage>,
    #[cfg(target_arch="wasm32")]
    operations: usize,
    mesh: RetainedTessellation,
    outcome: NumericalOutcome,
}
impl BrowserPlaneClip {
    pub fn belongs_to(&self, domain: &super::BrowserCancellation) -> bool { Arc::ptr_eq(&self.owner,&domain.owner) }
    pub fn handle(&self) -> &BrowserObjectHandle { &self.handle }
    pub fn operation_identity(&self) -> &BrowserPlaneClipIdentity { &self.identity }
    pub fn lineage(&self) -> &RetainedLineage { &self.lineage }
    pub fn world_from_evaluation(&self) -> &[f64;16] { &self.identity.world_from_evaluation }
    pub fn mesh(&self) -> &RetainedTessellation { &self.mesh }
    pub fn outcome(&self) -> NumericalOutcome { self.outcome }
    pub fn is_empty(&self) -> bool { self.outcome==NumericalOutcome::Empty }
    pub fn validate_live(&self) -> Result<(),RetainedRefusal> {
        self.owner.validate()?;
        if !self.live.load(Ordering::Acquire) { return Err(RetainedRefusal::InvalidRuntime); }
        #[cfg(target_arch="wasm32")]
        if !self.owner.driver.object_live(&self.object) { return Err(RetainedRefusal::InvalidRuntime); }
        Ok(())
    }
    #[cfg(target_arch="wasm32")]
    pub(super) fn transform_parts(&self) -> Result<super::affine::TransformParts,RetainedRefusal> {
        self.validate_live()?;
        Ok(super::affine::TransformParts {owner:self.owner.clone(),object:self.object.clone(),handle:self.handle.clone(),
            lineage:self.lineage.clone(),operations:self.operations})
    }
    #[cfg(target_arch="wasm32")]
    pub(super) fn dependency_parts(&self) -> Result<super::dependencies::Input,RetainedRefusal> {
        self.validate_live()?;
        Ok(super::dependencies::Input {owner:self.owner.clone(),object:self.object.clone(),handle:self.handle.clone(),
            frame:*self.world_from_evaluation(),lineage:self.lineage.clone(),operations:self.operations})
    }
}
impl Drop for BrowserPlaneClip {
    fn drop(&mut self) {
        self.live.store(false,Ordering::Release);
        #[cfg(target_arch="wasm32")]
        self.owner.driver.release_object(&self.object);
    }
}
#[cfg(target_arch="wasm32")]
impl super::BrowserWorker {
    /// Plane coefficients use the selected actual BRep local metre domain.
    /// Proper-rigid world placement remains outside the numerical operation.
    // Keep the explicit plane/side/mode distinct from display transfer limits.
    #[allow(clippy::too_many_arguments)]
    pub async fn clip_retained_plane(&mut self, source: super::BrowserDependency<'_>, plane: [f64;6],
        side: PlaneSide, mode: PlaneClipMode, chord: f64, angle: f64, max_bytes: u32)
        -> Result<BrowserPlaneClip,wasm_bindgen::JsValue>
    {
        use wasm_bindgen::JsValue;
        let error=|e:RetainedRefusal|JsValue::from_str(&e.to_string());
        crate::plane::validate_plane(&plane).map_err(JsValue::from_str)?;
        super::bridge::validate_plane_arguments(&plane,side.code(),mode.code())?;
        super::evaluation_limits(chord,angle,max_bytes).map_err(error)?;
        self.owner.validate().map_err(error)?;
        let source=source.input().map_err(error)?;
        if !self.owner.independent_leases || !Arc::ptr_eq(&self.owner,&source.owner) {
            return Err(error(RetainedRefusal::InvalidRuntime));
        }
        let operations=source.operations.checked_add(1).filter(|n|*n<=128)
            .ok_or_else(||JsValue::from_str("retained clip depth/work"))?;
        let mut flight=super::InFlight::new(&self.owner);
        let value=wasm_bindgen_futures::JsFuture::from(self.owner.driver.clip_plane(
            &source.object,&plane,side.code(),mode.code(),chord,angle,max_bytes)).await;
        let value=match value { Ok(value)=>value, Err(error)=> {
            if self.owner.driver.live() { flight.disarm(); }
            return Err(error);
        }};
        self.owner.validate().map_err(error)?;
        let get=|key|js_sys::Reflect::get(&value,&JsValue::from_str(key));
        let object=get("object")?;
        if !self.owner.driver.object_live(&object) { return Err(error(RetainedRefusal::InvalidRuntime)); }
        let bytes=js_sys::Uint8Array::new(&get("certificate")?).to_vec();
        // Captured by the driver from its private source-token map, not supplied
        // by any public caller. Decoder also checks the echoed input and output.
        let input=crate::protocol::WireHandle::from_bytes(&js_sys::Uint8Array::new(&get("input")?).to_vec())
            .map_err(|_|JsValue::from_str("invalid captured plane input"))?;
        let certificate=Arc::new(PlaneCertificate::decode(&bytes,input,plane,side,mode).map_err(JsValue::from_str)?);
        let mesh=super::bridge::mesh(&value)?;
        let outcome=super::bridge::outcome(&value,&mesh)?;
        if outcome!=certificate.outcome() { return Err(error(RetainedRefusal::Contract)); }
        let handle=BrowserObjectHandle::new();
        let result=BrowserPlaneClip {owner:self.owner.clone(),handle:handle.clone(),live:AtomicBool::new(true),object,
            operations,mesh,outcome,
            identity:BrowserPlaneClipIdentity {input:source.handle,output:handle,plane,side,mode,
                world_from_evaluation:source.frame,certificate:Arc::clone(&certificate)},
            lineage:Arc::new(RetainedLineage::PlaneClip {input:source.lineage,plane,side,mode,
                world_from_evaluation:source.frame,certificate})};
        result.validate_live().map_err(error)?;
        flight.disarm(); Ok(result)
    }
}
#[cfg(all(test,target_arch="wasm32"))]
#[path="browser_clip_tests.rs"]
mod tests;
