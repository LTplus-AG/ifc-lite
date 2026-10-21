// SPDX-License-Identifier: MPL-2.0
//! Sealed empty outcomes, certified by the actual retained solid. An empty
//! retained Boolean result is a valid numerical value, not a worker failure.
use super::{BrepHandle, SmlibWorker, TessellatedMesh, WorkerError};
use crate::protocol::KernelCommand;

/// Adapter capability bit of the semantic empty query (opcode 19).
const SEMANTIC_EMPTY: u32 = 32;

/// Classification of a strict tessellation, sealed from the actual retained
/// solid. Zero counts alone are no proof: an all-zero mesh is accepted only
/// with the solid's own semantic empty certificate. Grants no result authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumericalOutcome {
    NonEmpty,
    Empty,
}

impl SmlibWorker {
    /// Semantic emptiness of the actual retained solid: no boundary topology
    /// and only known-void regions. A zero volume or mesh is no such proof.
    pub fn is_empty(&mut self, solid: BrepHandle) -> Result<bool, WorkerError> {
        if self.capabilities()? & SEMANTIC_EMPTY == 0 {
            return Err(self.poison("semantic empty query unavailable"));
        }
        let solid = self.wire(solid)?;
        let bytes = self.call(KernelCommand::IsEmpty {
            session: self.session,
            solid,
        })?;
        match u32::from_le_bytes(self.fixed(bytes)?) {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(self.poison("invalid semantic empty result")),
        }
    }

    /// An all-zero strict mesh of `solid` is sealed empty only with the
    /// solid's own certificate; otherwise the adapter broke its contract.
    pub(super) fn certify_empty(
        &mut self,
        solid: BrepHandle,
    ) -> Result<TessellatedMesh, WorkerError> {
        if !self.is_empty(solid)? {
            return Err(self.poison("zero tessellation of a nonempty solid"));
        }
        Ok(TessellatedMesh::empty())
    }
}
