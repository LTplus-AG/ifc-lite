// SPDX-License-Identifier: MPL-2.0
//! Bounded staged recipe upload; no implicit replay after ambiguous delivery.
use super::{BrepHandle, SmlibWorker, WorkerError};
use crate::protocol::{KernelCommand, MAX_SWEEP_CHUNK_BYTES};

/// Adapter admission bounds for one staged recipe (see the C ABI header).
const MAX_RECIPE_BYTES: usize = 1_048_576;
const MAX_SEGMENTS: u32 = 8192;
const MAX_LOOPS: u32 = 128;

impl SmlibWorker {
    /// Upload one format 1 (region) or format 2 (disk) recipe and commit it.
    /// The adapter publishes a solid only after its own manifold/volume checks.
    pub(super) fn create_sweep(
        &mut self,
        bytes: &[u8],
        format: u32,
        loops: u32,
        segments: u32,
    ) -> Result<BrepHandle, WorkerError> {
        let length =
            u32::try_from(bytes.len()).map_err(|_| WorkerError::ResourceLimit("sweep size"))?;
        if !(1..=2).contains(&format)
            || bytes.len() > MAX_RECIPE_BYTES
            || segments == 0
            || segments > MAX_SEGMENTS
            || loops == 0
            || loops > MAX_LOOPS
            || loops > segments
        {
            return Err(WorkerError::ResourceLimit("sweep declaration"));
        }
        let bits = self.capabilities()?;
        if bits & (1 << (format - 1)) == 0 {
            return Err(WorkerError::Protocol("staged sweep extension unavailable"));
        }
        let response = self.call(KernelCommand::SweepBegin {
            session: self.session,
            format,
            length,
            loops,
            segments,
        })?;
        let upload = u64::from_le_bytes(self.fixed(response)?);
        if upload == 0 {
            return Err(self.poison("zero upload token"));
        }
        let mut offset = 0u32;
        for chunk in bytes.chunks(MAX_SWEEP_CHUNK_BYTES) {
            // A rejected chunk discards the transaction at the ABI, and a
            // transport failure has already retired the worker: no abort.
            let response = self.call(KernelCommand::SweepChunk {
                session: self.session,
                upload,
                offset,
                bytes: chunk.to_vec(),
            })?;
            if !response.is_empty() {
                return Err(self.poison("unexpected upload result"));
            }
            // Bounded by MAX_RECIPE_BYTES above.
            offset += chunk.len() as u32;
        }
        let result = self.call(KernelCommand::SweepCommit {
            session: self.session,
            upload,
        })?;
        self.handle(result)
    }
}
