// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The sizing and hand-off methods of [`AdmissionGuard`], split out of
//! `admission.rs` to stay under the module-size budget. A child module, so it
//! still reaches the private fields and helpers of its parent.

use super::{AdmissionGuard, ResidentBytes, BYTES_PER_PERMIT};
use crate::error::ApiError;

impl AdmissionGuard {
    /// Give back every reserved byte above `bytes`.
    ///
    /// Never grows the reservation, and never drops below one permit. Not
    /// used by the upload routes: a parse's measured peak is 20-33x its
    /// upload, so no fixed multiplier makes a smaller charge safe (#7676,
    /// SERVER-24, deferred to L-server). It is for a caller whose real size is
    /// known up front, such as a cache read.
    pub fn shrink_to(&mut self, bytes: u64) {
        if let Some(mem) = self.mem.as_mut() {
            let keep = bytes.div_ceil(BYTES_PER_PERMIT).max(1) as usize;
            let held = mem.num_permits();
            if held > keep {
                drop(mem.split(held - keep));
            }
        }
    }

    /// The bytes this guard currently reserves, in whole permits (0 with the
    /// byte gate disabled). Hand it to [`Self::shrink_to`] to restore it.
    pub fn reserved(&self) -> u64 {
        self.mem.as_ref().map_or(0, |mem| mem.num_permits() as u64 * BYTES_PER_PERMIT)
    }

    /// Make sure this job is charged at least `bytes`; returns what it held
    /// before, for [`Self::shrink_to`] to put back. A cache hit on an upload
    /// route is charged the stored entry's size this way, as the GET routes
    /// are, instead of only the upload's (#7676, SERVER-24).
    ///
    /// It only ever grows, so giving the extra back is a pure shrink that
    /// cannot fail: an upload already admitted is never refused because a
    /// cache lookup missed. The growth waits for the extra bytes like any
    /// waiter: bounded by `queue_timeout`, counted in the queue, answered
    /// `503` on timeout, with everything already held kept meanwhile.
    pub async fn grow_to(&mut self, bytes: u64) -> Result<u64, ApiError> {
        let before = self.reserved();
        let want = self.admission.permits_for(bytes) as usize;
        let held = self.mem.as_ref().map_or(usize::MAX, |mem| mem.num_permits());
        if held < want {
            let extra = self.admission.acquire_more((want - held) as u32).await?;
            // Same semaphore, so the permits merge into one.
            if let (Some(mem), Some(extra)) = (self.mem.as_mut(), extra) {
                mem.merge(extra);
            }
        }
        Ok(before)
    }

    /// End the job: free its CPU slot now and keep only its bytes, for as
    /// long as the returned value lives. See [`ResidentBytes`].
    pub fn into_resident(mut self) -> ResidentBytes {
        ResidentBytes { _mem: self.mem.take() }
    }
}
