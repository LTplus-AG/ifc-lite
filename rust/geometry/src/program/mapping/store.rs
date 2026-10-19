// SPDX-License-Identifier: MPL-2.0
//! Router-local provisional claims. Suspended frames retain opaque IDs only;
//! the leased execution store performs rollback when cancelled or dropped.
use super::occurrence::ProvisionalTemplate;
use rustc_hash::FxHashMap;
use std::sync::atomic::{AtomicU64, Ordering};
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) struct ClaimId(u64);
#[derive(Default)]
pub(crate) struct MappingStore { claims: FxHashMap<ClaimId, ProvisionalTemplate> }
impl MappingStore {
    pub(super) fn insert(&mut self, claim: ProvisionalTemplate) -> ClaimId {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = ClaimId(NEXT.fetch_add(1, Ordering::Relaxed));
        self.claims.insert(id, claim);
        id
    }
    pub(super) fn get(&self, id: ClaimId) -> Option<&ProvisionalTemplate> { self.claims.get(&id) }
    pub(super) fn release(&mut self, id: ClaimId) { self.claims.remove(&id); }
    pub(crate) fn cancel(&mut self) { self.claims.clear(); }
}

impl Drop for MappingStore {
    fn drop(&mut self) { self.cancel(); }
}
