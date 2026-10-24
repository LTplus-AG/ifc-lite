// SPDX-License-Identifier: MPL-2.0
//! Unary clip consumer of the same issued operation and certificate as native.
use super::*;
use super::{bridge::{driver_error, Mesh}, receipt::{BrowserObjectKey, BrowserReceipt}};
use ifc_lite_geometry::{document::{retained_plane::{PlaneCertificate, PlaneSide, PlaneClipMode,
    WireHandle, NumericalOutcome, validate_plane}, retained_lineage::{RetainedLineage, MAX_OPERATIONS}},
    program::{RetainedUnaryClip, RetainedClipMode}};
use ifc_lite_processing::element::runtime::{NumericalLimits, NumericalReceipt, Operand};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

pub struct BrowserPlaneClip {
    pub(super) domain: BrowserCancellation,
    pub(super) identity: BrowserObjectKey,
    pub(super) input: BrowserObjectKey,
    pub(super) plane: [f64; 6],
    pub(super) side: PlaneSide,
    pub(super) mode: PlaneClipMode,
    pub(super) frame: [f64; 16],
    pub(super) certificate: Arc<PlaneCertificate>,
    pub(super) lineage: Arc<RetainedLineage>,
    pub(super) operations: usize,
    pub(super) object: JsValue,
    pub(super) mesh: Mesh,
}
impl BrowserPlaneClip {
    pub(super) fn validate_live(&self) -> Result<(), BrowserError> {
        self.domain.owner.validate()?;
        if !self.domain.owner.driver.object_live(&self.object) { return Err(BrowserError::WrongWorker); }
        Ok(())
    }
}
impl Drop for BrowserPlaneClip {
    fn drop(&mut self) { self.domain.owner.driver.release_object(&self.object); }
}
fn bounded_bytes(value: &JsValue, key: &str, min: u32, max: u32) -> Result<Vec<u8>, BrowserError> {
    let field = js_sys::Reflect::get(value, &JsValue::from_str(key)).map_err(driver_error)?;
    let bytes = field.dyn_into::<js_sys::Uint8Array>().map_err(|_| BrowserError::Driver("clip evidence is not bytes".into()))?;
    if bytes.length() < min || bytes.length() > max { return Err(BrowserError::Driver("clip evidence bound".into())); }
    Ok(bytes.to_vec())
}
impl BrowserWorker {
    pub(super) async fn evaluate_retained_clip(&mut self, input: Operand<'_, BrowserReceipt>,
        clip: &RetainedUnaryClip, limits: NumericalLimits) -> Result<BrowserPlaneClip, BrowserError> {
        self.owner.validate()?;
        validate_plane(&clip.local_plane).map_err(|e| BrowserError::Driver(e.into()))?;
        let max_bytes = u32::try_from(limits.max_bytes).map_err(|_| BrowserError::InvalidLimits)?;
        evaluation_limits(limits.chord_metres, limits.angle_degrees, max_bytes)?;
        let domain = self.cancellation();
        let placed = super::boolean::place(input, &domain)?;
        if placed.frame.iter().zip(clip.input_frame).any(|(a,b)| a.to_bits() != b.to_bits()) {
            return Err(BrowserError::Driver("clip input frame mismatch".into()));
        }
        if !self.dependencies_qualified { return Err(BrowserError::Unqualified("run this Worker's dependency witnesses first")); }
        let operations = placed.count.checked_add(1).filter(|n| *n <= MAX_OPERATIONS)
            .ok_or_else(|| BrowserError::Driver("retained clip depth/work".into()))?;
        let side = if clip.keeps_negative_side() { PlaneSide::Negative } else { PlaneSide::Positive };
        let mode = match clip.mode { RetainedClipMode::Difference => PlaneClipMode::Difference,
            RetainedClipMode::Intersection => PlaneClipMode::Intersection };
        let identity = BrowserObjectKey(next_identity()?);
        let mut flight = InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.evaluate_clip(placed.receipt.driver_object(),
            &clip.local_plane, side.code(), mode.code(), limits.chord_metres, limits.angle_degrees, max_bytes))
            .await.map_err(driver_error)?;
        self.owner.validate()?;
        placed.receipt.validate_live()?;
        let input_wire = bounded_bytes(&value, "input", 16, 16)?;
        let output_wire = bounded_bytes(&value, "output", 16, 16)?;
        let bytes = bounded_bytes(&value, "certificate", 312, 2488)?;
        let input_wire = WireHandle::from_bytes(&input_wire).map_err(|e| BrowserError::Driver(e.into()))?;
        let certificate = Arc::new(PlaneCertificate::decode(&bytes, input_wire, clip.local_plane, side, mode)
            .map_err(|e| BrowserError::Driver(e.into()))?);
        if certificate.output_handle().to_bytes().as_slice() != output_wire {
            return Err(BrowserError::Driver("clip output lease mismatch".into()));
        }
        let object = js_sys::Reflect::get(&value, &JsValue::from_str("object")).map_err(driver_error)?;
        let mesh = js_sys::Reflect::get(&value, &JsValue::from_str("mesh")).map_err(driver_error)?;
        let mesh: Mesh = serde_wasm_bindgen::from_value(mesh).map_err(|e| BrowserError::Driver(e.to_string()))?;
        if mesh.empty != (certificate.outcome() == NumericalOutcome::Empty) {
            return Err(BrowserError::Driver("clip empty certificate mismatch".into()));
        }
        let result = BrowserPlaneClip { domain, identity, input: placed.receipt.object(),
            plane: clip.local_plane, side, mode, frame: placed.frame, certificate: certificate.clone(),
            lineage: Arc::new(RetainedLineage::PlaneClip { input: placed.lineage, plane: clip.local_plane,
                side, mode, world_from_evaluation: placed.frame, certificate }), operations, object, mesh };
        result.validate_live()?;
        flight.disarm();
        Ok(result)
    }
}
