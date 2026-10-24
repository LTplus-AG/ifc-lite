// SPDX-License-Identifier: MPL-2.0
//! Actual module-Worker receipts implement the common processing runtime seam.
use super::*;
use ifc_lite_processing::element::{RetainedExecutionError, runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, NumericalReceipt,
    ReceiptDomain, ReceiptEvidence, RetainedRuntime,
}};

/// Opaque equality key for one evaluated object. It grants no Worker access.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct BrowserObjectKey(pub(super) u64);

pub enum BrowserReceipt {
    Construction(Box<BrowserRealization>),
    Affine(Box<super::dependencies::BrowserAffineCopy>),
    Boolean(Box<super::boolean::BrowserBooleanResult>),
}

impl ReceiptDomain for BrowserCancellation {
    fn same_domain(&self, other: &Self) -> bool { BrowserCancellation::same_domain(self, other) }
    fn incarnation(&self) -> Option<u64> { BrowserCancellation::incarnation(self) }
    fn retire(&self) { BrowserCancellation::retire(self) }
}
impl NumericalReceipt for BrowserReceipt {
    type Object = BrowserObjectKey;
    type Domain = BrowserCancellation;
    type Error = BrowserError;
    fn heap_bytes() -> u64 { std::mem::size_of::<BrowserRealization>().max(std::mem::size_of::<super::dependencies::BrowserAffineCopy>()).max(std::mem::size_of::<super::boolean::BrowserBooleanResult>()) as u64 }
    fn object(&self) -> Self::Object {
        match self { Self::Construction(value) => BrowserObjectKey(value.identity), Self::Affine(value) => value.identity, Self::Boolean(value) => value.identity }
    }
    fn evidence(&self) -> ReceiptEvidence<'_, Self::Object> {
        match self { Self::Construction(value) => ReceiptEvidence::Construction(value.completion()),
            Self::Affine(value) => ReceiptEvidence::Affine { input: value.input, column_major: &value.column_major },
            Self::Boolean(value) => ReceiptEvidence::Boolean { operation: value.operation,
                left: value.left, right: value.right, world_from_left: &value.world_from_left,
                world_from_right: &value.world_from_right, world_from_evaluation: &value.world_from_left,
                empty: value.mesh.empty } }
    }
    fn domain(&self) -> &Self::Domain {
        match self { Self::Construction(value) => &value.domain, Self::Affine(value) => &value.domain, Self::Boolean(value) => &value.domain }
    }
    fn validate_live(&self) -> Result<(), Self::Error> {
        match self { Self::Construction(value) => value.validate_live(), Self::Affine(value) => value.validate_live(), Self::Boolean(value) => value.validate_live() }
    }
}
impl RetainedRuntime for BrowserWorker {
    type Receipt = BrowserReceipt;
    fn domain(&self) -> BrowserCancellation { self.cancellation() }
    fn incarnation(&self) -> u64 { BrowserWorker::incarnation(self) }
}
impl AsyncRetainedExecutor for BrowserWorker {
    async fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits)
        -> Result<Self::Receipt, RetainedExecutionError> {
        let max_bytes = u32::try_from(limits.max_bytes)
            .map_err(|_| RetainedExecutionError::Runtime("browser mesh budget exceeds u32".into()))?;
        match call {
            Invocation::Construction(request) => self.evaluate_retained(request.clone(), limits.chord_metres, limits.angle_degrees, max_bytes)
                .await.map(|value| BrowserReceipt::Construction(Box::new(value)))
                .map_err(|error| RetainedExecutionError::Runtime(error.to_string())),
            Invocation::Affine { input, column_major } => self.copy_retained_affine(input, column_major)
                .await.map(|value| BrowserReceipt::Affine(Box::new(value)))
                .map_err(|error| RetainedExecutionError::Runtime(error.to_string())),
            Invocation::Boolean { left, right, operation } => self.evaluate_retained_boolean(left, right, operation, limits)
                .await.map(|value| BrowserReceipt::Boolean(Box::new(value)))
                .map_err(|error| RetainedExecutionError::Runtime(error.to_string())),
        }
    }
}
