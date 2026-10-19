// SPDX-License-Identifier: MPL-2.0
//! Bounded owned numerical transaction; no implicit replay after ambiguous delivery.
use super::{BrepHandle, SmlibWorker, WorkerError};
use crate::protocol::KernelCommand;

impl SmlibWorker {
    pub(super) fn create_sweep(&mut self, bytes: &[u8], format: u32, loops: u32, segments: u32) -> Result<BrepHandle, WorkerError> {
        let length =
            u32::try_from(bytes.len()).map_err(|_| WorkerError::ResourceLimit("sweep size"))?;
        if !(1..=2).contains(&format) || bytes.len() > 1_048_576 || segments == 0 || segments > 8192
            || loops == 0 || loops > 128 || loops > segments {
            return Err(WorkerError::ResourceLimit("sweep declaration"));
        }
        let capabilities = self.call(KernelCommand::Capabilities)?;
        if capabilities.len() != 8
            || capabilities[..4] != 1u32.to_le_bytes()
            || u32::from_le_bytes(capabilities[4..].try_into().expect("four bytes")) & (1 << format.saturating_sub(1)) == 0
        {
            return Err(WorkerError::Protocol("staged sweep extension unavailable"));
        }
        let response = self.call(KernelCommand::SweepBegin {
            session: self.session,
            length,
            format,
            loops,
            segments,
        })?;
        let upload = u64::from_le_bytes(self.fixed(response)?);
        if upload == 0 {
            return Err(self.poison("zero upload token"));
        }
        for (index, chunk) in bytes.chunks(3840).enumerate() {
            let result = self.call(KernelCommand::SweepChunk {
                session: self.session,
                upload,
                offset: (index * 3840) as u32,
                bytes: chunk.to_vec(),
            });
            match result {
                Ok(response) if response.is_empty() => (),
                Ok(_) => return Err(self.poison("unexpected upload result")),
                Err(error) => {
                    // Chunk domain failures discard the transaction at the ABI.
                    // Abort is best effort; inability to clean retires the worker.
                    if self
                        .call(KernelCommand::SweepAbort {
                            session: self.session,
                            upload,
                        })
                        .is_err()
                    {
                        self.retire();
                    }
                    return Err(error);
                }
            }
        }
        let result = self.call(KernelCommand::SweepCommit {
            session: self.session,
            upload,
        })?;
        self.handle(result)
    }
}
