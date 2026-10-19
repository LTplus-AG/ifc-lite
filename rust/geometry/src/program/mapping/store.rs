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
    pub(super) fn insert(&mut self, claim: ProvisionalTemplate) -> crate::Result<ClaimId> {
        crate::resource::charge(crate::resource::Cost {work:1,
            live_bytes:std::mem::size_of::<(ClaimId,ProvisionalTemplate)>() as u64,..Default::default()})?.retain();
        self.claims.try_reserve(1).map_err(|_|crate::resource::allocation_failure())?;
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = ClaimId(NEXT.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|n|n.checked_add(1)).map_err(|_|crate::resource::overflow())?);
        self.claims.insert(id, claim);
        Ok(id)
    }
    pub(super) fn get(&self, id: ClaimId) -> Option<&ProvisionalTemplate> { self.claims.get(&id) }
    pub(super) fn release(&mut self, id: ClaimId) { self.claims.remove(&id); }
    pub(crate) fn cancel(&mut self) { self.claims.clear(); }
}

impl Drop for MappingStore {
    fn drop(&mut self) { self.cancel(); }
}
