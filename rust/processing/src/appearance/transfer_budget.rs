// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Aggregate scan-owned memory and work, including atlas samples and BVH traversal.
pub(super) struct TransferBudget {
    pub work: usize,
    pub category:usize, pub charges:[usize;6],pub calls:[usize;4],pub sample_work:[usize;2],
    memory: usize,
}
impl TransferBudget {
    pub fn new() -> Self {
        Self {
            work: 1_000_000_000,category:5,charges:[0;6],calls:[0;4],sample_work:[0;2],
            memory: 256 * 1024 * 1024,
        }
    }
    pub fn charge(&mut self, work: usize) -> Result<(), String> {
        self.charges[self.category]+=work;
        self.work = self
            .work
            .checked_sub(work)
            .ok_or("Transfer work budget exhausted; reduce source extent or atlas density")?;
        Ok(())
    }
    pub fn reserve(&mut self, bytes: usize) -> Result<(), String> {
        self.memory = self
            .memory
            .checked_sub(bytes)
            .ok_or("Transfer memory budget exhausted; reduce source extent or atlas density")?;
        Ok(())
    }
}
