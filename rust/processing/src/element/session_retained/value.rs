// SPDX-License-Identifier: MPL-2.0
//! Sealed construction and physical-copy receipts, independent of source handles.
use super::*;
use super::runtime::NumericalReceipt;
pub(super) struct RuntimeRealization<R: NumericalReceipt> {
    pub(super) kind: R,
    // Sealed by the immutable issued packet at execution, independent of equal
    // input handles/matrices. Callers cannot rebind a numerical result.
    pub(super) definition: LogicalRetainedDefinition,
    pub(super) empty: bool,
    pub(super) _permit: Reservation,
    pub(super) _buffers: Reservation,
    // Runtime lineage retains authored requests. Keep their charges alive even
    // if a detached later result outlives the controller and its input ledger.
    pub(super) _source: Option<Arc<Storage>>,
    pub(super) _inputs: [Option<Arc<Self>>; 2],
}
impl<R: NumericalReceipt> RuntimeRealization<R> {
    pub(super) fn is_empty(&self) -> bool { self.empty }
    pub(super) fn validate_live(&self) -> Result<(), R::Error> {
        self.kind.validate_live()
    }
    pub(super) fn owner(&self) -> &R::Domain {
        self.kind.domain()
    }
    pub(super) fn header_bytes() -> u64 {
        (std::mem::size_of::<Self>() + 2 * std::mem::size_of::<usize>()) as u64 + R::heap_bytes()
    }
}
