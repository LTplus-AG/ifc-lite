// SPDX-License-Identifier: MPL-2.0
//! Ordered live Boolean operands captured from the transaction ledger.
use super::*;
use super::runtime::{NumericalReceipt, ReceiptEvidence};
use super::runtime::Operand;

pub(super) struct BooleanInput<R: NumericalReceipt> {
    pub realization: Arc<RuntimeRealization<R>>,
    pub frame: [f64; 16],
    source_frame: Option<[f64; 16]>,
}
impl<R: NumericalReceipt> BooleanInput<R> {
    pub(super) fn new(realization: Arc<RuntimeRealization<R>>, value: ValueRef<'_>)
        -> Result<Self, RetainedExecutionError> {
        let source_frame = value.world_from_source().copied();
        if matches!(realization.kind.evidence(), ReceiptEvidence::Construction(_)) != source_frame.is_some() {
            return Err(protocol(ReceiptFailure::BooleanInputDefinitionReceiptKindMismatch));
        }
        Ok(Self { realization, frame: *value.object_frame(), source_frame })
    }
    pub(super) fn operand(&self) -> Operand<'_, R> {
        match self.source_frame {
            Some(world_from_source) => Operand::Source { receipt: &self.realization.kind, world_from_source },
            None => Operand::Placed { receipt: &self.realization.kind, world_from_object: self.frame },
        }
    }
}
pub(super) fn operation(value: ifc_lite_geometry::BoolOp) -> Result<ifc_lite_geometry::BoolOp, RetainedExecutionError> {
    match value {
        ifc_lite_geometry::BoolOp::Union | ifc_lite_geometry::BoolOp::Intersection | ifc_lite_geometry::BoolOp::Difference => Ok(value),
        _ => Err(protocol(ReceiptFailure::UnsupportedRetainedBooleanOperator)),
    }
}

impl<R: NumericalReceipt> Clone for BooleanInput<R> {
    fn clone(&self) -> Self {
        Self { realization: self.realization.clone(), frame: self.frame, source_frame: self.source_frame }
    }
}
