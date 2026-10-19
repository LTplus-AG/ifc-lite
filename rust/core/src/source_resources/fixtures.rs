// SPDX-License-Identifier: MPL-2.0
//! Real bounded accounting and storage observation, attached to actual source work.
use super::backend::{Backend, Cost, Resources, StorageEvent};
use super::gate::Gate;
use super::{coverage, failure};
use crate::execution_owner::{ExecutionWork, SourceResourceContext, AllocationClass};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use crate::{EntityDecoder, SourceBundle};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Default, Debug)]
pub(super) struct Stats {
    pub live: u64, pub observed: u64, pub peak: u64, pub work: u64, pub copies: u64,
    pub allocations: u64, pub frees: u64, pub replacements: u64, pub refunded: u64,
    pub terminal: Option<ProgramStop>, pub violation: bool,
}
struct State { stats: Stats, metadata: Stats, limit: u64 }
pub(super) struct Budget(Mutex<State>);
impl Budget {
    pub fn new(limit: u64) -> Arc<Self> {
        Arc::new(Self(Mutex::new(State { stats: Stats::default(), metadata: Stats::default(), limit })))
    }
    pub fn stats(&self) -> Stats {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).stats
    }
    pub fn limit(&self, limit: u64) {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        state.limit = limit.saturating_add(state.metadata.live);
    }
}
impl Backend for Budget {
    fn check(&self) -> Result<(), ProgramStop> { self.stats().terminal.map_or(Ok(()), Err) }
    fn admit(&self, cost: Cost) -> Result<(), ProgramStop> {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(stop) = state.stats.terminal { return Err(stop); }
        let total = state.stats.live.checked_add(state.metadata.live).and_then(|n| n.checked_add(cost.live));
        let limit = state.limit;
        let stats = match cost.class {
            AllocationClass::Container => &mut state.stats,
            AllocationClass::Metadata => &mut state.metadata,
        };
        let work = stats.work.checked_add(cost.work);
        let copies = stats.copies.checked_add(cost.copies);
        let (Some(work), Some(copies)) = (work, copies) else {
            let stop = failure(Dimension::Work, u64::MAX, 0, RefusalReason::Overflow);
            state.stats.terminal = Some(stop); return Err(stop);
        };
        stats.work = work;
        stats.copies = copies;
        if total.is_none_or(|next| next > limit) {
            let used = state.stats.live.saturating_add(state.metadata.live);
            let stop = failure(Dimension::LiveBytes, cost.live, limit.saturating_sub(used),
                if total.is_none() { RefusalReason::Overflow } else { RefusalReason::Limit });
            state.stats.terminal = Some(stop); return Err(stop);
        }
        stats.live += cost.live;
        stats.peak = stats.peak.max(stats.live);
        Ok(())
    }
    fn refund(&self, bytes: u64, class: AllocationClass) {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let stats = match class {
            AllocationClass::Container => &mut state.stats,
            AllocationClass::Metadata => &mut state.metadata,
        };
        match stats.live.checked_sub(bytes) {
            Some(live) => {
                stats.live = live;
                stats.refunded = stats.refunded.saturating_add(bytes);
                if stats.observed > live { stats.violation = true; }
            }
            None => { stats.violation = true; state.stats.terminal.get_or_insert(coverage()); }
        }
    }
    fn stop(&self, stop: ProgramStop) -> ProgramStop {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *state.stats.terminal.get_or_insert(stop)
    }
    fn observe(&self, event: StorageEvent, class: AllocationClass) {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let stats = match class {
            AllocationClass::Container => &mut state.stats,
            AllocationClass::Metadata => &mut state.metadata,
        };
        let next = match event {
            StorageEvent::Allocated(bytes) => {
                stats.allocations = stats.allocations.saturating_add(1);
                stats.observed.checked_add(bytes)
            }
            StorageEvent::Deallocated(bytes) => {
                stats.frees = stats.frees.saturating_add(1);
                stats.observed.checked_sub(bytes)
            }
            StorageEvent::Replaced { old, new } => {
                stats.replacements = stats.replacements.saturating_add(1);
                stats.observed.checked_sub(old).and_then(|n| n.checked_add(new))
            }
        };
        match next {
            Some(bytes) => {
                stats.observed = bytes;
                if bytes > stats.live { stats.violation = true; }
            }
            None => stats.violation = true,
        }
    }
}
pub(super) fn context(resources: &Arc<Resources>) -> SourceResourceContext {
    SourceResourceContext::new_accounted(Arc::clone(resources))
}
pub(super) fn setup(limit: u64) -> (Arc<SourceBundle>, Arc<Resources>, Arc<Budget>) {
    let budget = Budget::new(limit);
    let backend: Arc<dyn Backend> = budget.clone();
    let resources = Resources::new(backend).unwrap();
    let source = SourceBundle::new(b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));".to_vec());
    (source, resources, budget)
}
pub(super) fn run<T>(limit: u64, operation: impl FnOnce(&mut EntityDecoder<'_>, &ExecutionWork<'_>,
    &Gate, &Arc<Budget>, &Arc<Resources>) -> T) -> T {
    // Fund actual metadata first, then set one total limit to retained metadata
    // plus the requested container allowance. stats() remains container-only so
    // historical storage invariants do not confuse control and source Layouts.
    let (source, resources, budget) = setup(u64::MAX);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    let gate = Gate::new(&decoder, &work).unwrap();
    budget.limit(limit);
    operation(&mut decoder, &work, &gate, &budget, &resources)
}
pub(super) fn clean(budget: &Budget) {
    let stats = budget.stats();
    assert_eq!((stats.live, stats.observed), (0, 0));
    assert!(!stats.violation, "refund preceded actual deallocation or exceeded debit: {stats:?}");
    let state = budget.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(state.metadata.live, state.metadata.observed);
    assert!(!state.metadata.violation, "metadata must obey the same free-before-refund ordering");
}
