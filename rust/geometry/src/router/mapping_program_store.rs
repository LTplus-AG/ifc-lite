// SPDX-License-Identifier: MPL-2.0
//! Router-local mapping leases. Owned programs send cleanup IDs without keeping
//! router authority or a RefCell borrow across suspension.
use super::GeometryRouter;
use crate::program::mapping::MappingStore;
use rustc_hash::FxHashMap;
use std::{cell::RefCell, sync::{Arc, Mutex}};

pub(crate) type CleanupQueue = Arc<Mutex<Vec<u64>>>;
#[derive(Default)]
pub(super) struct MappingProgramStores {
    stores: RefCell<FxHashMap<u64, MappingStore>>,
    cleanup: std::cell::OnceCell<CleanupQueue>,
}
impl GeometryRouter {
    pub(crate) fn mapping_cleanup_queue(&self) -> CleanupQueue {
        self.mapping_program_stores.cleanup.get_or_init(Default::default).clone()
    }
    pub(crate) fn with_mapping_program_store<T>(&self, id: u64, f: impl FnOnce(&mut MappingStore) -> T) -> T {
        self.drain_mapping_cleanup();
        // Mapping source admissions do not invoke extension callbacks. A child
        // is always executed after this lexical borrow has ended.
        let mut stores = self.mapping_program_stores.stores.borrow_mut();
        f(stores.entry(id).or_default())
    }
    pub(crate) fn drain_mapping_cleanup(&self) {
        let Some(cleanup) = self.mapping_program_stores.cleanup.get() else { return };
        let ids = std::mem::take(&mut *cleanup.lock().unwrap_or_else(|e| e.into_inner()));
        let mut stores = self.mapping_program_stores.stores.borrow_mut();
        for id in ids { stores.remove(&id); }
    }
}
