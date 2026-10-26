// SPDX-License-Identifier: MPL-2.0
//! Bind executor evidence to the immutable issued output definition.
use super::*;
use super::runtime::{NumericalReceipt, ReceiptEvidence};

impl<R: NumericalReceipt> IssuedRetainedOperation<R> {
    pub(super) fn seal(&self, kind: R, permit: Reservation, resources: &OwnedResourceContext)
        -> Result<Arc<RuntimeRealization<R>>, RetainedExecutionError> {
        // The transport bounded allocation before reading. Admit actual owned
        // buffer capacities to the captured account before delivery/acceptance.
        let buffers = resources.with_scope(|| resource::charge(resource::Cost {
            live_bytes: kind.buffer_bytes().map_err(runtime_fault)?, ..Default::default()
        }).map_err(RetainedExecutionError::Stopped))?;
        let empty = match (kind.evidence(), self) {
            // Both runtimes reject empty source constructions.
            (ReceiptEvidence::Construction(_), Self::Construction { .. }) => false,
            (ReceiptEvidence::Boolean { empty, .. }, Self::Boolean { .. }) => empty,
            (ReceiptEvidence::Affine { .. }, Self::Affine { input, .. }) => input.is_empty(),
            _ => return Err(protocol(ReceiptFailure::NumericalResultKindMismatch)),
        };
        let value = RuntimeRealization {
            kind, empty, definition: self.definition().clone(), _permit: permit, _buffers: buffers,
            _source: match self { Self::Construction { backing, .. } => Some(backing.clone()), _ => None },
            _inputs: match self {
                Self::Construction { .. } => [None, None],
                Self::Affine { input, .. } => [Some(input.clone()), None],
                Self::Boolean { inputs, .. } => [Some(inputs[0].realization.clone()), Some(inputs[1].realization.clone())],
            },
        };
        value.validate_live().map_err(runtime_fault)?;
        Ok(Arc::new(value))
    }
}
