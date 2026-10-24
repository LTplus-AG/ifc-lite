// SPDX-License-Identifier: MPL-2.0
//! Bind executor evidence to the immutable issued output definition.
use super::*;
use super::runtime::{NumericalReceipt, ReceiptEvidence};

impl<R: NumericalReceipt> IssuedRetainedOperation<R> {
    pub(super) fn seal(&self, kind: R, permit: Reservation)
        -> Result<Arc<RuntimeRealization<R>>, RetainedExecutionError> {
        let empty = match (kind.evidence(), self) {
            // Both runtimes reject empty source constructions.
            (ReceiptEvidence::Construction(_), Self::Construction { .. }) => false,
            (ReceiptEvidence::Boolean { empty, .. }, Self::Boolean { .. }) => empty,
            (ReceiptEvidence::UnaryClip { empty, .. }, Self::UnaryClip { .. }) => empty,
            (ReceiptEvidence::Affine { .. }, Self::Affine { input, .. }) => input.is_empty(),
            _ => return Err(protocol("numerical result kind mismatch")),
        };
        let value = RuntimeRealization {
            kind, empty, definition: self.definition().clone(), _permit: permit,
        };
        value.validate_live().map_err(protocol)?;
        Ok(Arc::new(value))
    }
}
