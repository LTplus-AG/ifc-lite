// SPDX-License-Identifier: MPL-2.0
//! Cache storage retains request accounts independently of failed later work.
use super::{GeometryRouter, SharedMappedItemCache};
use crate::resource::{self, Cost, ExecutionAccount, ProgramStop};
use std::sync::{Arc, Mutex};

/// Opt-in mapped source cache ownership. Unlike the legacy shared cache alias,
/// this handle never exposes naked cached mesh Arcs. Completed entries keep the
/// publishing request account alive, conservatively retaining its full pooled
/// allowance. This is not exact cache-byte reconciliation or a process bound.
#[derive(Clone)]
pub struct AccountedMappedItemCache {
    cache: SharedMappedItemCache,
    accounts: Arc<Mutex<Vec<ExecutionAccount>>>,
}

impl AccountedMappedItemCache {
    pub fn new() -> Self {
        Self {
            cache: GeometryRouter::new_mapped_item_cache(),
            accounts: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
impl Default for AccountedMappedItemCache {
    fn default() -> Self {
        Self::new()
    }
}

fn retain_account(
    accounts: &mut Vec<ExecutionAccount>,
    account: ExecutionAccount,
) -> Result<(), ProgramStop> {
    // One owner record per reached publication; source identity is not used to
    // deduplicate real concurrent work or refund already copied allocations.
    let width = std::mem::size_of::<ExecutionAccount>() as u64;
    let count = u64::try_from(accounts.len()).map_err(|_| resource::overflow())?;
    let growth = accounts.len() == accounts.capacity();
    let live_bytes = if growth {
        count
            .checked_add(1)
            .and_then(|v| v.checked_mul(width))
            .ok_or_else(resource::overflow)?
    } else {
        0
    };
    if live_bytes > isize::MAX as u64 {
        return Err(resource::overflow());
    }
    let copy_bytes = if growth {
        count.checked_mul(width).ok_or_else(resource::overflow)?
    } else {
        0
    };
    let permit = resource::charge(Cost {
        work: 1,
        copy_bytes,
        live_bytes,
        ..Cost::default()
    })?;
    accounts
        .try_reserve_exact(1)
        .map_err(|_| resource::allocation_failure())?;
    accounts.push(account);
    permit.retain();
    Ok(())
}

impl GeometryRouter {
    /// A fresh empty shared `IfcMappedItem` source cache, to be cloned into every
    /// per-element / per-batch router of ONE loaded model so a mapped source shared
    /// across owning elements is meshed once model-wide (#1623). Mirrors
    /// [`Self::new_dedup_cache`]. Keep one per model/pass: the cached meshes bake in
    /// this pass's unit scale / tessellation quality.
    pub fn new_mapped_item_cache() -> SharedMappedItemCache {
        Arc::new(Mutex::new(rustc_hash::FxHashMap::default()))
    }

    /// Inject a shared `IfcMappedItem` source cache (see
    /// [`Self::new_mapped_item_cache`]) into this router. All routers given the
    /// SAME `Arc` mesh each unique `IfcRepresentationMap` source once across the
    /// whole model, instead of once per owning element (a fresh router is built per
    /// element). Takes precedence over the per-router RefCell `mapped_item_cache`;
    /// leaving it unset keeps the per-router fallback for single-shot callers.
    pub fn enable_shared_mapped_item_cache(&mut self, cache: SharedMappedItemCache) {
        self.execution_owner.changed();
        self.shared_mapped_item_cache = Some(cache);
        self.accounted_mapped_cache = None;
    }

    /// Bind retained cache storage to its admission owner. Ordinary borrowed
    /// cache APIs remain compatible and cannot qualify bounded publication.
    pub fn enable_accounted_mapped_item_cache(&mut self, cache: AccountedMappedItemCache) {
        self.execution_owner.changed();
        self.shared_mapped_item_cache = Some(Arc::clone(&cache.cache));
        self.accounted_mapped_cache = Some(cache);
    }

    // Shared marker ownership for provisional mapped-template admission. This
    // borrows the existing set; no source maps are cloned per product.
    pub(crate) fn materialized_source_handle(&self) -> std::rc::Rc<std::cell::RefCell<rustc_hash::FxHashSet<u32>>> {
        std::rc::Rc::clone(&self.instanced_sources_materialized)
    }

    pub(crate) fn retain_local_resource_account(&self) -> Result<(), ProgramStop> {
        if let Some(account) = resource::current_account() {
            retain_account(&mut self.mapped_cache_accounts.borrow_mut(), account)?;
        }
        Ok(())
    }

    pub(crate) fn check_mapped_cache_coverage(&self) -> Result<(), ProgramStop> {
        resource::check_current()?;
        if resource::is_active()
            && self.shared_mapped_item_cache.is_some()
            && self.accounted_mapped_cache.is_none()
        {
            return Err(resource::refused(
                resource::Dimension::Coverage,
                0,
                0,
                resource::RefusalReason::UnsupportedCoverage,
            ));
        }
        Ok(())
    }

    /// Call after complete source production but before inserting the owned
    /// cache payload. A later branch failure cannot discard this retained owner.
    pub(crate) fn retain_mapped_cache_account(&self, _source_id: u32) -> Result<(), ProgramStop> {
        self.check_mapped_cache_coverage()?;
        let Some(account) = resource::current_account() else {
            return Ok(());
        };
        match &self.accounted_mapped_cache {
            Some(cache) => retain_account(
                &mut cache.accounts.lock().unwrap_or_else(|e| e.into_inner()),
                account,
            ),
            None => retain_account(&mut self.mapped_cache_accounts.borrow_mut(), account),
        }
    }
}

#[cfg(test)]
#[path = "mapped_cache_ownership_tests.rs"]
mod tests;
