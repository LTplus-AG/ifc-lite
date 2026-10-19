// SPDX-License-Identifier: MPL-2.0
//! Candidate browser affine lease; target qualification remains independent.
use super::{BrowserObjectHandle, Owner};
use crate::{AffineCertificate,RetainedLineage};
use ifc_lite_geometry::document::RetainedRefusal;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

pub enum BrowserTransformInput<'a> {
    Source(&'a super::BrowserRealization),
    Result(&'a super::BrowserDependencyResult),
    Affine(&'a BrowserAffineCopy),
}
#[cfg(target_arch="wasm32")]
pub(super) struct TransformParts {
    pub owner: Arc<Owner>,
    pub object: wasm_bindgen::JsValue,
    pub handle: BrowserObjectHandle,
    pub lineage: Arc<RetainedLineage>,
    pub operations: usize,
}
#[cfg(target_arch="wasm32")]
impl BrowserTransformInput<'_> {
    fn parts(self) -> Result<TransformParts, RetainedRefusal> {
        match self {
            Self::Source(source) => {
                source.validate_live()?;
                let completion=&source.completion;
                Ok(TransformParts { owner:source.owner.clone(), object:source.object.clone(),
                    handle:source.handle.clone(), operations:0,
                    lineage:Arc::new(RetainedLineage::Definition { request:Box::new(completion.request().clone()),
                        source_from_evaluation:completion.source_from_evaluation,
                        evaluation_from_source:completion.evaluation_from_source }) })
            }
            Self::Result(result) => result.transform_parts(),
            Self::Affine(copy) => copy.transform_parts(),
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserAffineIdentity {
    pub input: BrowserObjectHandle,
    pub column_major: [f64; 16],
    pub certificate: AffineCertificate,
}
pub struct BrowserAffineCopy {
    owner: Arc<Owner>,
    handle: BrowserObjectHandle,
    live: AtomicBool,
    #[cfg(target_arch="wasm32")]
    object: wasm_bindgen::JsValue,
    identity: BrowserAffineIdentity,
    lineage: Arc<RetainedLineage>,
    #[cfg(target_arch="wasm32")]
    operations: usize,
}
impl BrowserAffineCopy {
    pub fn handle(&self) -> &BrowserObjectHandle { &self.handle }
    pub fn operation_identity(&self) -> &BrowserAffineIdentity { &self.identity }
    pub fn lineage(&self) -> &RetainedLineage { &self.lineage }
    #[cfg(target_arch="wasm32")]
    pub(super) fn transform_parts(&self) -> Result<TransformParts,RetainedRefusal> {
        self.validate_live()?;
        Ok(TransformParts { owner:self.owner.clone(),object:self.object.clone(),handle:self.handle.clone(),
            lineage:self.lineage.clone(),operations:self.operations })
    }
    pub fn validate_live(&self) -> Result<(), RetainedRefusal> {
        self.owner.validate()?;
        if !self.live.load(Ordering::Acquire) { return Err(RetainedRefusal::InvalidRuntime); }
        #[cfg(target_arch="wasm32")]
        if !self.owner.driver.object_live(&self.object) { return Err(RetainedRefusal::InvalidRuntime); }
        Ok(())
    }
}
impl Drop for BrowserAffineCopy {
    fn drop(&mut self) {
        self.live.store(false,Ordering::Release);
        #[cfg(target_arch="wasm32")]
        self.owner.driver.release_object(&self.object);
    }
}
#[cfg(target_arch="wasm32")]
impl super::BrowserWorker {
    /// Copies sealed source/result/copy geometry from this actual owner. No final-product or
    /// browser numerical qualification is conferred by successful conversion.
    pub async fn copy_retained_affine(&mut self, source: BrowserTransformInput<'_>, column_major: [f64;16])
        -> Result<BrowserAffineCopy, wasm_bindgen::JsValue>
    {
        use wasm_bindgen::JsValue;
        let error=|e:RetainedRefusal| JsValue::from_str(&e.to_string());
        crate::affine::validate_affine(&column_major).map_err(JsValue::from_str)?;
        self.owner.validate().map_err(error)?;
        let source=source.parts().map_err(error)?;
        if !self.owner.independent_leases || !Arc::ptr_eq(&self.owner,&source.owner) {
            return Err(error(RetainedRefusal::InvalidRuntime));
        }
        let operations=source.operations.checked_add(1).filter(|n|*n<=128)
            .ok_or_else(|| JsValue::from_str("retained affine depth/work"))?;
        let mut flight=super::InFlight::new(&self.owner);
        let value=wasm_bindgen_futures::JsFuture::from(
            self.owner.driver.copy_affine(&source.object,&column_major)).await;
        // Driver reports a synchronized kernel refusal only after validating
        // version/id/status and guaranteeing no published copy. It retains the
        // source; transport uncertainty still invalidates the captured owner.
        let value=match value {
            Ok(value)=>value,
            Err(error)=> {
                if self.owner.driver.live() { flight.disarm(); }
                return Err(error);
            }
        };
        self.owner.validate().map_err(error)?;
        let object=js_sys::Reflect::get(&value,&JsValue::from_str("object"))?;
        let bytes=js_sys::Uint8Array::new(&js_sys::Reflect::get(&value,&JsValue::from_str("certificate"))?).to_vec();
        let certificate=AffineCertificate::decode(&bytes).map_err(JsValue::from_str)?;
        let result=BrowserAffineCopy { owner:self.owner.clone(), handle:BrowserObjectHandle::new(),
            live:AtomicBool::new(true), object,
            identity:BrowserAffineIdentity { input:source.handle.clone(),column_major,certificate:certificate.clone() },
            lineage:Arc::new(RetainedLineage::AffineCopy { input:source.lineage,column_major,certificate }), operations };
        result.validate_live().map_err(error)?; flight.disarm(); Ok(result)
    }
}
