// SPDX-License-Identifier: MPL-2.0
//! Ordered dependency evaluation in the left operand's metre frame.
use super::*;
use super::bridge::{driver_error, Mesh};
use super::receipt::{BrowserObjectKey, BrowserReceipt};
use ifc_lite_geometry::{BoolOp, document::{retained_frames::{multiply, relative, rigid},
    retained_lineage::{BooleanOperation, RetainedLineage, MAX_OPERATIONS}}};
use ifc_lite_processing::element::runtime::{NumericalLimits, NumericalReceipt, Operand};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

pub struct BrowserBooleanResult {
    pub(super) domain: BrowserCancellation,
    pub(super) identity: BrowserObjectKey,
    pub(super) left: BrowserObjectKey,
    pub(super) right: BrowserObjectKey,
    pub(super) operation: BoolOp,
    pub(super) world_from_left: [f64; 16],
    pub(super) world_from_right: [f64; 16],
    pub(super) lineage: Arc<RetainedLineage>,
    pub(super) operations: usize,
    pub(super) object: JsValue,
    pub(super) mesh: Mesh,
}
impl BrowserBooleanResult {
    pub(super) fn validate_live(&self) -> Result<(), BrowserError> {
        self.domain.owner.validate()?;
        if !self.domain.owner.driver.object_live(&self.object) { return Err(BrowserError::WrongWorker); }
        Ok(())
    }
}
impl Drop for BrowserBooleanResult {
    fn drop(&mut self) { self.domain.owner.driver.release_object(&self.object); }
}
pub(super) struct Placed<'a> {
    pub(super) receipt: &'a BrowserReceipt,
    pub(super) frame: [f64; 16],
    pub(super) lineage: Arc<RetainedLineage>,
    pub(super) count: usize,
}
pub(super) fn place<'a>(operand: Operand<'a, BrowserReceipt>, domain: &BrowserCancellation) -> Result<Placed<'a>, BrowserError> {
    let (receipt, supplied, source) = match operand {
        Operand::Source { receipt, world_from_source } => (receipt, world_from_source, true),
        Operand::Placed { receipt, world_from_object } => (receipt, world_from_object, false),
    };
    if !receipt.belongs_to_domain(domain) { return Err(BrowserError::WrongWorker); }
    receipt.validate_live()?;
    let (frame, lineage, count) = match (source, receipt) {
        (true, BrowserReceipt::Construction(value)) => {
            let frame = multiply(supplied, value.completion().source_from_evaluation);
            (frame, Arc::new(RetainedLineage::Source { request: Box::new(value.completion().request().clone()),
                world_from_source: supplied }), 0)
        }
        (false, BrowserReceipt::Affine(_) | BrowserReceipt::Boolean(_) | BrowserReceipt::UnaryClip(_)) => {
            let (value, count) = receipt.lineage_parts();
            (supplied, Arc::new(RetainedLineage::Placed { value, world_from_evaluation: supplied }), count)
        }
        _ => return Err(BrowserError::Driver("operand frame kind does not match sealed receipt".into())),
    };
    rigid(frame).map_err(|error| BrowserError::Driver(error.into()))?;
    Ok(Placed { receipt, frame, lineage, count })
}
impl BrowserWorker {
    pub(super) async fn evaluate_retained_boolean(&mut self, left: Operand<'_, BrowserReceipt>,
        right: Operand<'_, BrowserReceipt>, operation: BoolOp, limits: NumericalLimits)
        -> Result<BrowserBooleanResult, BrowserError> {
        self.owner.validate()?;
        let max_bytes = u32::try_from(limits.max_bytes).map_err(|_| BrowserError::InvalidLimits)?;
        evaluation_limits(limits.chord_metres, limits.angle_degrees, max_bytes)?;
        let domain = self.cancellation();
        let left = place(left, &domain)?;
        let right = place(right, &domain)?;
        if !self.dependencies_qualified { return Err(BrowserError::Unqualified("run this Worker's dependency witnesses first")); }
        let (wire, kind) = match operation {
            BoolOp::Union => (1, BooleanOperation::Union),
            BoolOp::Intersection => (2, BooleanOperation::Intersection),
            BoolOp::Difference => (3, BooleanOperation::Difference),
            _ => return Err(BrowserError::Driver("unsupported Boolean operation".into())),
        };
        let operations = left.count.checked_add(right.count).and_then(|n| n.checked_add(1))
            .filter(|&n| n <= MAX_OPERATIONS).ok_or_else(|| BrowserError::Driver("retained dependency depth".into()))?;
        let relative = relative(left.frame, right.frame).map_err(|error| BrowserError::Driver(error.into()))?;
        let identity = BrowserObjectKey(next_identity()?);
        let mut flight = InFlight::new(&self.owner);
        let value = JsFuture::from(self.owner.driver.evaluate_boolean(left.receipt.driver_object(),
            right.receipt.driver_object(), &relative, wire, limits.chord_metres, limits.angle_degrees, max_bytes))
            .await.map_err(driver_error)?;
        self.owner.validate()?;
        left.receipt.validate_live()?;
        right.receipt.validate_live()?;
        let object = js_sys::Reflect::get(&value, &JsValue::from_str("object")).map_err(driver_error)?;
        let mesh = js_sys::Reflect::get(&value, &JsValue::from_str("mesh")).map_err(driver_error)?;
        let mesh: Mesh = serde_wasm_bindgen::from_value(mesh).map_err(|error| BrowserError::Driver(error.to_string()))?;
        let result = BrowserBooleanResult { domain, identity, object, mesh, operation, operations,
            left: left.receipt.object(), right: right.receipt.object(), world_from_left: left.frame,
            world_from_right: right.frame, lineage: Arc::new(RetainedLineage::Boolean {
                operation: kind, left: left.lineage, right: right.lineage }) };
        result.validate_live()?;
        flight.disarm();
        Ok(result)
    }
}
