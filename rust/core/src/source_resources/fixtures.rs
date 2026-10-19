// SPDX-License-Identifier: MPL-2.0
//! Real bounded accounting and storage observation, attached to actual source work.
use super::backend::{Backend, Cost, Resources, StorageEvent};
use super::gate::Gate;
use super::{coverage, failure};
use crate::execution_owner::{ExecutionWork, SourceResourceContext};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use crate::{EntityDecoder, SourceBundle};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Default, Debug)]
pub(super) struct Stats {
    pub live: u64, pub observed: u64, pub peak: u64, pub work: u64, pub copies: u64,
    pub allocations: u64, pub frees: u64, pub replacements: u64, pub refunded: u64,
    pub terminal: Option<ProgramStop>, pub violation: bool,
}
struct State { stats: Stats, limit: u64 }
pub(super) struct Budget(Mutex<State>);
impl Budget {
    pub fn new(limit: u64) -> Arc<Self> {
        Arc::new(Self(Mutex::new(State { stats: Stats::default(), limit })))
    }
    pub fn stats(&self) -> Stats {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).stats
    }
    pub fn limit(&self, limit: u64) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).limit = limit;
    }
}
impl Backend for Budget {
    fn check(&self) -> Result<(), ProgramStop> { self.stats().terminal.map_or(Ok(()), Err) }
    fn admit(&self, cost: Cost) -> Result<(), ProgramStop> {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(stop) = state.stats.terminal { return Err(stop); }
        let work = state.stats.work.checked_add(cost.work);
        let copies = state.stats.copies.checked_add(cost.copies);
        let (Some(work), Some(copies)) = (work, copies) else {
            let stop = failure(Dimension::Work, u64::MAX, 0, RefusalReason::Overflow);
            state.stats.terminal = Some(stop); return Err(stop);
        };
        // Attempted work/copy cost remains consumed even when live admission fails.
        state.stats.work = work;
        state.stats.copies = copies;
        let next = state.stats.live.checked_add(cost.live);
        if next.is_none_or(|next| next > state.limit) {
            let stop = failure(Dimension::LiveBytes, cost.live, state.limit.saturating_sub(state.stats.live),
                if next.is_none() { RefusalReason::Overflow } else { RefusalReason::Limit });
            state.stats.terminal = Some(stop); return Err(stop);
        }
        if let Some(live) = next {
            state.stats.live = live;
            state.stats.peak = state.stats.peak.max(live);
        }
        Ok(())
    }
    fn refund(&self, bytes: u64) {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.stats.live.checked_sub(bytes) {
            Some(live) => {
                state.stats.live = live;
                state.stats.refunded = state.stats.refunded.saturating_add(bytes);
                if state.stats.observed > live { state.stats.violation = true; }
            }
            None => { state.stats.violation = true; state.stats.terminal.get_or_insert(coverage()); }
        }
    }
    fn stop(&self, stop: ProgramStop) -> ProgramStop {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *state.stats.terminal.get_or_insert(stop)
    }
    fn observe(&self, event: StorageEvent) {
        let mut state = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = match event {
            StorageEvent::Allocated(bytes) => {
                state.stats.allocations = state.stats.allocations.saturating_add(1);
                state.stats.observed.checked_add(bytes)
            }
            StorageEvent::Deallocated(bytes) => {
                state.stats.frees = state.stats.frees.saturating_add(1);
                state.stats.observed.checked_sub(bytes)
            }
            StorageEvent::Replaced { old, new } => {
                state.stats.replacements = state.stats.replacements.saturating_add(1);
                state.stats.observed.checked_sub(old).and_then(|n| n.checked_add(new))
            }
        };
        match next {
            Some(bytes) => {
                state.stats.observed = bytes;
                if bytes > state.stats.live { state.stats.violation = true; }
            }
            None => state.stats.violation = true,
        }
    }
}
pub(super) fn context(resources: &Arc<Resources>) -> SourceResourceContext {
    SourceResourceContext::new(Arc::clone(resources))
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
    let (source, resources, budget) = setup(limit);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    let gate = Gate::new(&decoder, &work).unwrap();
    operation(&mut decoder, &work, &gate, &budget, &resources)
}
pub(super) fn clean(budget: &Budget) {
    let stats = budget.stats();
    assert_eq!((stats.live, stats.observed), (0, 0));
    assert!(!stats.violation, "refund preceded actual deallocation or exceeded debit: {stats:?}");
}
