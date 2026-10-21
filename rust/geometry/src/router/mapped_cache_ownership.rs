// SPDX-License-Identifier: MPL-2.0
//! Cache storage retains request accounts independently of failed later work.
use super::{GeometryRouter, SharedMappedItemCache};
use crate::resource::{self, Cost, ExecutionAccount, ProgramStop};
use crate::{Error, Mesh};
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

fn unsupported_coverage() -> ProgramStop {
    resource::refused(
        resource::Dimension::Coverage,
        0,
        0,
        resource::RefusalReason::UnsupportedCoverage,
    )
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
        self.shared_mapped_item_cache = Some(cache);
        self.accounted_mapped_cache = None;
    }

    /// Bind retained cache storage to its admission owner. Ordinary borrowed
    /// cache APIs remain compatible and cannot qualify bounded publication.
    pub fn enable_accounted_mapped_item_cache(&mut self, cache: AccountedMappedItemCache) {
        self.shared_mapped_item_cache = Some(Arc::clone(&cache.cache));
        self.accounted_mapped_cache = Some(cache);
    }

    /// Router-local caches (the hash cache and the RefCell mapped fallback) keep
    /// their publishing accounts alive for exactly the router's lifetime.
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
            return Err(unsupported_coverage());
        }
        Ok(())
    }

    /// The shared content-dedup cache stores unaccounted deep copies with no
    /// admission owner: bounded execution refuses it rather than claim coverage.
    pub(super) fn check_item_dedup_coverage(&self) -> Result<(), ProgramStop> {
        if self.item_dedup_cache.is_some() && resource::is_active() {
            return Err(unsupported_coverage());
        }
        Ok(())
    }

    /// Call after complete source production but before inserting the owned
    /// cache payload. A later branch failure cannot discard this retained owner.
    pub(crate) fn retain_mapped_cache_account(&self) -> Result<(), ProgramStop> {
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

    /// Deep-copy a source mesh for a mapped-item cache. Without an installed
    /// account this is `Mesh::clone`; with one, cache coverage is checked and the
    /// copy admitted before any allocation, so a zero or overflowing allowance
    /// refuses it with the cache untouched. The published storage stays charged
    /// for the cache's lifetime: the cache owner retains the publishing account.
    pub(super) fn clone_source_for_cache(&self, mesh: &Mesh) -> crate::Result<Arc<Mesh>> {
        if !crate::resource::is_active() {
            return Ok(Arc::new(mesh.clone()));
        }
        self.check_mapped_cache_coverage()?;
        let (copy, permit) = crate::resource::mesh::clone_mesh(mesh)?;
        self.retain_mapped_cache_account()?;
        permit.retain();
        Ok(Arc::new(copy))
    }

    /// A program stop reached by a source item is terminal for the whole walk;
    /// any other item failure stays an ordinary recoverable drop.
    pub(super) fn recoverable_source_error(error: Error) -> crate::Result<Error> {
        match crate::resource::observe::<()>(Err(error)) {
            Err(stop @ Error::ProgramStopped(_)) => Err(stop),
            Err(error) => Ok(error),
            Ok(()) => Ok(Error::geometry("source item failed")),
        }
    }

    /// Accounted copy for both cache population and every cache hit, so a
    /// repeated occurrence is charged (or refused) like the first one.
    pub(super) fn clone_cached_mesh(&self, mesh: &Mesh) -> crate::Result<Mesh> {
        // A hit is coverage too: under a bounded account an ordinary
        // (unaccounted) shared cache is refused on lookup, not only on insert.
        if self.shared_mapped_item_cache.is_some() {
            self.check_mapped_cache_coverage()?;
        }
        if !crate::resource::is_active() {
            return Ok(mesh.clone());
        }
        let (copy, permit) = crate::resource::mesh::clone_mesh(mesh)?;
        permit.retain();
        Ok(copy)
    }
}

#[cfg(test)]
#[path = "mapped_cache_ownership_tests.rs"]
mod tests;
