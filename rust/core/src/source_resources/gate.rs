// SPDX-License-Identifier: MPL-2.0
use super::allocator::ResourceAllocator;
use super::backend::{Cost, MAX_BINDINGS};
#[cfg(test)]
use super::backend::{Resources, fixture_resources};
use super::coverage;
use crate::execution_owner::{resource_prototype::{Authority, work_original_stop}, ExecutionWork,
    AccountedArc, AllocationAccount, AllocationObserverHandle, SourceResourceContext, SourceStopHandle};
use crate::resource_stop::ProgramStop;
use crate::{EntityDecoder, SourceBundle};
use std::{marker::PhantomData, rc::Rc, sync::{Arc, Mutex, Weak}};

struct Binding { current: Option<Authority>, depth: usize }
pub(super) struct GateInner {
    account: Arc<dyn AllocationAccount>, context: SourceResourceContext,
    original: SourceStopHandle, observer: Option<AllocationObserverHandle>,
    // Historical fixture feasibility counters, never production account quotas.
    #[cfg(test)]
    fixture: Option<Arc<Resources>>,
    source: Weak<SourceBundle>, binding: Mutex<Binding>,
}
#[cfg(test)]
impl Drop for GateInner {
    fn drop(&mut self) { if let Some(resources) = &self.fixture { resources.release_gate(); } }
}
#[derive(Clone)]
pub(super) struct Gate(AccountedArc<GateInner>);
struct Restore {
    gate: AccountedArc<GateInner>, previous: Option<Authority>,
    _thread_bound: PhantomData<Rc<()>>,
}
impl Drop for Restore {
    fn drop(&mut self) {
        let (displaced, broken) = {
            let mut state = self.gate.binding.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let displaced = std::mem::replace(&mut state.current, self.previous.take());
            let broken = match state.depth.checked_sub(1) {
                Some(depth) => { state.depth = depth; false }
                None => true,
            };
            (displaced, broken)
        };
        drop(displaced); // No resource/context destruction under the binding lock.
        if broken { Gate(self.gate.clone()).record(coverage()); }
    }
}
impl Gate {
    #[cfg(test)]
    pub fn new(decoder: &EntityDecoder<'_>, work: &ExecutionWork<'_>) -> Result<Self, ProgramStop> {
        Self::new_with_observer(decoder, work, None)
    }
    pub fn new_with_observer(decoder: &EntityDecoder<'_>, work: &ExecutionWork<'_>,
        observer: Option<AllocationObserverHandle>) -> Result<Self, ProgramStop> {
        let authority = Authority::capture(decoder, work).map_err(|_| {
            work_original_stop(decoder, work).ok().flatten().unwrap_or_else(coverage)
        })?;
        let original = authority.stop_handle();
        let context = authority.resources.clone();
        let account = context.allocation_account().ok_or_else(|| authority.stop(coverage()))?;
        let paired = observer.as_ref().is_none_or(|observer| observer.account_context()
            .is_some_and(|other| context.same_account(&other)));
        if !paired { return Err(authority.stop(account.stop(coverage()))); }
        let record = |stop| record_channels(&original, account.as_ref(), observer.as_ref(), stop);
        original.check().map_err(record)?;
        account.check().map_err(record)?;
        if let Some(observer) = &observer { observer.check().map_err(record)?; }
        #[cfg(test)]
        let fixture = fixture_resources(&context);
        #[cfg(test)]
        if let Some(resources) = &fixture { resources.reserve_gate().map_err(record)?; }
        let inner = GateInner { account: account.clone(), context: context.clone(), original: original.clone(),
            observer: observer.clone(),
            #[cfg(test)]
            fixture,
            source: Arc::downgrade(&authority.source),
            binding: Mutex::new(Binding { current: None, depth: 0 }) };
        AccountedArc::try_new(inner, &context, Some(original.clone())).map(Self).map_err(record)
    }
    pub fn scope<'source, T>(&self, decoder: &mut EntityDecoder<'source>, work: &ExecutionWork<'_>,
        operation: impl FnOnce(&mut EntityDecoder<'source>, &ResourceAllocator) -> Result<T, ProgramStop>)
        -> Result<T, ProgramStop> {
        if let Some(stop) = work_original_stop(decoder, work).map_err(|_| self.record(coverage()))? {
            self.0.original.stop(stop);
            return Err(self.record(stop));
        }
        let authority = Authority::capture(decoder, work).map_err(|_| self.record(coverage()))?;
        authority.original_stop().map_err(|stop| {
            self.0.original.stop(stop);
            self.record(stop)
        })?;
        if !self.0.context.same_account(&authority.resources)
            || !self.0.source.upgrade().is_some_and(|source| Arc::ptr_eq(&authority.source, &source)) {
            return Err(self.record(coverage()));
        }
        // Select retained source/account/observer precedence before committing
        // the fresh epoch's irreversible first fault. No binding exists yet.
        self.0.original.check().map_err(|stop| authority.stop(self.record(stop)))?;
        self.0.account.check().map_err(|stop| authority.stop(self.record(stop)))?;
        if let Some(observer) = &self.0.observer {
            observer.check().map_err(|stop| authority.stop(self.record(stop)))?;
        }
        let previous = {
            let mut state = self.0.binding.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.depth >= MAX_BINDINGS || state.current.as_ref().is_some_and(
                |previous| previous.thread() != std::thread::current().id()) {
                drop(state);
                return Err(authority.stop(self.record(coverage())));
            }
            state.depth += 1;
            state.current.replace(authority)
        };
        let _restore = Restore { gate: self.0.clone(), previous, _thread_bound: PhantomData };
        let result = operation(decoder, &ResourceAllocator::new(self.clone()))
            .map_err(|stop| self.record(stop));
        self.before(Cost::default())?;
        result
    }
    fn current(&self) -> Option<Authority> {
        self.0.binding.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current.clone()
    }
    pub fn before(&self, cost: Cost) -> Result<(), ProgramStop> {
        let authority = self.current();
        if let Some(active) = &authority { active.original_stop().map_err(|stop| self.record(stop))?; }
        self.0.original.check().map_err(|stop| self.record(stop))?;
        self.0.account.check().map_err(|stop| self.record(stop))?;
        if let Some(observer) = &self.0.observer { observer.check().map_err(|stop| self.record(stop))?; }
        let active = authority.ok_or_else(|| self.record(coverage()))?;
        active.validate().map_err(|_| self.record(coverage()))?;
        let live = active.live_resources().map_err(|_| self.record(coverage()))?;
        if !self.0.context.same_account(&live) { return Err(self.record(coverage())); }
        self.0.account.admit(cost).map_err(|stop| self.record(stop))
    }
    pub fn record(&self, stop: ProgramStop) -> ProgramStop {
        let authority = self.current();
        let original = authority.as_ref().and_then(|active| active.original_stop().err());
        if let Some(original) = original { self.0.original.stop(original); }
        let selected = original.unwrap_or(stop);
        let selected = record_channels(&self.0.original, self.0.account.as_ref(), self.0.observer.as_ref(), selected);
        authority.map_or(selected, |active| active.stop(selected))
    }
    pub fn backend(&self) -> &Arc<dyn AllocationAccount> { &self.0.account }
}
fn record_channels(source: &SourceStopHandle, account: &dyn AllocationAccount,
    observer: Option<&AllocationObserverHandle>, stop: ProgramStop) -> ProgramStop {
    let original = source.check().err();
    let prior = account.check().err();
    let captured = observer.and_then(|observer| observer.check().err());
    let selected = source.stop(original.or(prior).or(captured).unwrap_or(stop));
    account.stop(selected); // Keep its own first fault even when source wins.
    if let Some(observer) = observer { observer.record(selected); }
    source.check().err().unwrap_or(selected)
}
/// Existing owner/epoch backing is baseline; new gate/observer Arc backing is
/// explicitly admitted. Stack binding frames allocate no backing of their own.
#[cfg(test)]
pub(super) fn control_sizes() -> [usize; 8] {
    let (state, epoch) = crate::execution_owner::resource_prototype::metadata_sizes();
    [std::mem::size_of::<Resources>(), std::mem::size_of::<GateInner>(),
        std::mem::size_of::<Authority>(), std::mem::size_of::<Restore>(), state, epoch,
        std::mem::size_of::<ResourceAllocator>(), std::mem::size_of::<SourceResourceContext>()]
}
