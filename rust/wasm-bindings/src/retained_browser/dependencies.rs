// SPDX-License-Identifier: MPL-2.0
//! Sealed browser dependency receipts using the shared numerical contracts.
use super::*;
use super::bridge::driver_error;
use super::receipt::{BrowserObjectKey, BrowserReceipt};
use ifc_lite_geometry::document::{retained_affine::AffineCertificate,
    retained_frames::validate_affine, retained_lineage::{RetainedLineage, MAX_OPERATIONS}};
use ifc_lite_processing::element::runtime::NumericalReceipt;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

pub struct BrowserAffineCopy {
    pub(super) domain: BrowserCancellation,
    pub(super) identity: BrowserObjectKey,
    pub(super) input: BrowserObjectKey,
    pub(super) column_major: [f64; 16],
    pub(super) lineage: Arc<RetainedLineage>,
    pub(super) operations: usize,
    pub(super) object: JsValue,
}
impl BrowserAffineCopy {
    pub(super) fn validate_live(&self) -> Result<(), BrowserError> {
        self.domain.owner.validate()?;
        if !self.domain.owner.driver.object_live(&self.object) { return Err(BrowserError::WrongWorker); }
        Ok(())
    }
}
impl Drop for BrowserAffineCopy {
    fn drop(&mut self) { self.domain.owner.driver.release_object(&self.object); }
}

impl BrowserReceipt {
    pub(super) fn lineage_parts(&self) -> (Arc<RetainedLineage>, usize) {
        match self {
            Self::Construction(value) => {
                let completion = value.completion();
                (Arc::new(RetainedLineage::Definition {
                    request: Box::new(completion.request().clone()),
                    source_from_evaluation: completion.source_from_evaluation,
                    evaluation_from_source: completion.evaluation_from_source,
                }), 0)
            }
            Self::Affine(value) => (value.lineage.clone(), value.operations),
            Self::Boolean(value) => (value.lineage.clone(), value.operations),
        }
    }
    pub(super) fn driver_object(&self) -> &JsValue {
        match self { Self::Construction(value) => &value.object, Self::Affine(value) => &value.object, Self::Boolean(value) => &value.object }
    }
}

impl BrowserWorker {
    pub async fn qualify_dependencies(&mut self) -> Result<(), BrowserError> {
        self.owner.validate()?;
        self.dependencies_qualified = false;
        let mut flight = InFlight::new(&self.owner);
        JsFuture::from(self.owner.driver.qualify_dependencies()).await.map_err(driver_error)?;
        self.owner.validate()?;
        self.dependencies_qualified = true;
        flight.disarm();
        Ok(())
    }
    pub(super) async fn copy_retained_affine(&mut self, input: &BrowserReceipt, column_major: [f64; 16])
        -> Result<BrowserAffineCopy, BrowserError> {
        self.owner.validate()?;
        validate_affine(&column_major).map_err(|error| BrowserError::Driver(error.into()))?;
        if !input.belongs_to_domain(&self.cancellation()) { return Err(BrowserError::WrongWorker); }
        input.validate_live()?;
        if !self.dependencies_qualified { return Err(BrowserError::Unqualified("run this Worker's dependency witnesses first")); }
        let (lineage, count) = input.lineage_parts();
        let operations = count.checked_add(1).filter(|&n| n <= MAX_OPERATIONS)
            .ok_or_else(|| BrowserError::Driver("retained operation depth".into()))?;
        let identity = BrowserObjectKey(next_identity()?);
        let domain = self.cancellation();
        let mut flight = InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.copy_affine(input.driver_object(), &column_major))
            .await.map_err(driver_error)?;
        self.owner.validate()?;
        input.validate_live()?;
        let object = js_sys::Reflect::get(&value, &JsValue::from_str("object")).map_err(driver_error)?;
        let bytes = js_sys::Reflect::get(&value, &JsValue::from_str("certificate")).map_err(driver_error)?;
        let bytes = js_sys::Uint8Array::new(&bytes).to_vec();
        let certificate = AffineCertificate::decode(&bytes).map_err(|error| BrowserError::Driver(error.into()))?;
        let result = BrowserAffineCopy { domain, identity, input: input.object(), column_major,
            lineage: Arc::new(RetainedLineage::AffineCopy { input: lineage, column_major, certificate }),
            operations, object };
        result.validate_live()?;
        flight.disarm();
        Ok(result)
    }
}
