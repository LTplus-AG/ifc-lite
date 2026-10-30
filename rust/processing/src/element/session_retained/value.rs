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
    /// The opening element an M3 cut subtracted; persistent faces key its reveals `via` it.
    pub(super) opening: Option<u32>,
    pub(super) _permit: Reservation,
    pub(super) _buffers: Reservation,
    // Runtime lineage retains authored requests. Keep their charges alive even
    // if a detached later result outlives the controller and its input ledger.
    pub(super) _source: Option<Arc<Storage>>,
    pub(super) _inputs: [Option<Arc<Self>>; 2],
}
impl<R: NumericalReceipt> RuntimeRealization<R> {
    /// Follow only the host spine. A clipped opening/cutter does not qualify
    /// its host, and an unknown Union/Intersection does not qualify its branches.
    /// An M4 LayerRegion intersection preserves only its left host's lineage.
    pub(super) fn halfspace_clipped(&self) -> bool {
        use super::runtime::ReceiptEvidence;
        use ifc_lite_geometry::{BoolOp, document::PrismRole};
        let mut current = self;
        // Real runtime lineage is capped at 128 operations on both targets.
        for _ in 0..=128 {
            match current.kind.evidence() {
                ReceiptEvidence::Boolean { operation: BoolOp::Difference, .. } => {
                    if let Some(right) = current._inputs[1].as_deref() {
                        if let ReceiptEvidence::Construction(completion) = right.kind.evidence() {
                            if matches!(completion.request().recipe(), RetainedRecipe::Prism(p) if p.role == PrismRole::HalfSpace) {
                                return true;
                            }
                        }
                    }
                }
                ReceiptEvidence::Boolean { operation: BoolOp::Intersection, .. } => {
                    // #7955 M4/M5: this derived cutter is sealed by the band
                    // plan; arbitrary authored intersections still stop here.
                    let Some(right) = current._inputs[1].as_deref() else { return false; };
                    if !matches!(right.kind.evidence(), ReceiptEvidence::Construction(c)
                        if matches!(c.request().recipe(), RetainedRecipe::Prism(p) if p.role == PrismRole::LayerRegion)) {
                        return false;
                    }
                }
                ReceiptEvidence::Affine { .. } => {}
                _ => return false,
            }
            let Some(left) = current._inputs[0].as_deref() else { return false; };
            current = left;
        }
        false
    }
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
