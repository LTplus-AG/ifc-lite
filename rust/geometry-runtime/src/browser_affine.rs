// SPDX-License-Identifier: MPL-2.0
//! Candidate browser affine lease; target qualification remains independent.
use super::{BrowserObjectHandle, Owner};
use crate::AffineCertificate;
use ifc_lite_geometry::document::{RetainedRefusal, RetainedRequest};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

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
    source_request: RetainedRequest,
}
impl BrowserAffineCopy {
    pub fn handle(&self) -> &BrowserObjectHandle { &self.handle }
    pub fn operation_identity(&self) -> &BrowserAffineIdentity { &self.identity }
    pub fn source_request(&self) -> &RetainedRequest { &self.source_request }
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
    /// Copies only a sealed source from this actual owner. No final-product or
    /// browser numerical qualification is conferred by successful conversion.
    pub async fn copy_retained_affine(&mut self, source: &super::BrowserRealization, column_major: [f64;16])
        -> Result<BrowserAffineCopy, wasm_bindgen::JsValue>
    {
        use wasm_bindgen::JsValue;
        let error=|e:RetainedRefusal| JsValue::from_str(&e.to_string());
        crate::affine::validate_affine(&column_major).map_err(JsValue::from_str)?;
        self.owner.validate().map_err(error)?; source.validate_live().map_err(error)?;
        if !self.owner.independent_leases || !Arc::ptr_eq(&self.owner,&source.owner) {
            return Err(error(RetainedRefusal::InvalidRuntime));
        }
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
            identity:BrowserAffineIdentity { input:source.handle.clone(),column_major,certificate },
            source_request:source.completion.request().clone() };
        result.validate_live().map_err(error)?; flight.disarm(); Ok(result)
    }
}
