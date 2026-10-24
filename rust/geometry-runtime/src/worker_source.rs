// SPDX-License-Identifier: MPL-2.0
//! Only actual Worker IO registers source correspondence under an issued handle.
use super::{BrepHandle, SmlibWorker, WorkerError};
use crate::protocol::KernelCommand;
use ifc_lite_geometry::document::{retained_source::SourceCorrespondence, RetainedRequest};
use std::sync::Arc;
impl SmlibWorker {
    /// Explicit intermediate opt-in. Boolean/clip source proof is still refused.
    pub fn require_source_faces(&mut self) {
        self.source_faces_enabled = true;
    }
    pub fn source_faces_required(&self) -> bool {
        self.source_faces_enabled
    }

    pub(super) fn read_source(
        &mut self,
        object: BrepHandle,
        request: &RetainedRequest,
    ) -> Result<SourceCorrespondence, WorkerError> {
        let wire = self.wire(object)?;
        let bytes = self.call(KernelCommand::SourceInfo {
            session: self.session,
            object: wire,
        })?;
        SourceCorrespondence::decode(request, &wire.to_bytes(), &bytes).map_err(|e| self.poison(e))
    }
    pub(super) fn register_source(
        &mut self,
        object: BrepHandle,
        request: &RetainedRequest,
        prior: Option<&SourceCorrespondence>,
        operation: Option<u64>,
    ) -> Result<Arc<SourceCorrespondence>, WorkerError> {
        let proof = self.read_source(object, request)?;
        if prior.is_none()
            && !operation.is_some_and(|operation| {
                proof.is_initial_operation(&object.wire.to_bytes(), operation)
            })
        {
            return Err(self.poison("source construction operation binding mismatch"));
        }
        if prior.is_some_and(|prior| !proof.same_source(prior)) {
            return Err(self.poison("affine changed source inventory"));
        }
        if self.source_bindings.len() >= 4096 {
            return Err(self.poison("source registry bound"));
        }
        self.source_bindings
            .try_reserve(1)
            .map_err(|_| self.poison("source registry allocation"))?;
        let proof = Arc::new(proof);
        self.source_bindings.insert(object.wire, proof.clone());
        Ok(proof)
    }
}
