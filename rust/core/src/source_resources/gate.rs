// SPDX-License-Identifier: MPL-2.0
use super::allocator::ResourceAllocator;
use super::backend::{Cost, Resources, MAX_BINDINGS};
use super::{coverage, failure};
use crate::execution_owner::{resource_prototype::{Authority, work_original_stop}, ExecutionWork};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use crate::{EntityDecoder, SourceBundle};
use std::{marker::PhantomData, rc::Rc, sync::{Arc, Mutex, Weak}};

struct Binding { current: Option<Authority>, depth: usize }
pub(super) struct GateInner {
    pub resources: Arc<Resources>,
    source: Weak<SourceBundle>,
    binding: Mutex<Binding>,
}
impl Drop for GateInner {
    fn drop(&mut self) { self.resources.release_gate(); }
}
#[derive(Clone)]
pub(super) struct Gate(Arc<GateInner>);
struct Restore {
    gate: Arc<GateInner>,
    previous: Option<Authority>,
    _thread_bound: PhantomData<Rc<()>>,
}
impl Drop for Restore {
    fn drop(&mut self) {
        let broken = {
            let mut state = self.gate.binding.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            state.current = self.previous.take();
            match state.depth.checked_sub(1) {
                Some(depth) => { state.depth = depth; false }
                None => true,
            }
        };
        if broken { self.gate.resources.backend.stop(coverage()); }
    }
}
impl Gate {
    pub fn new(decoder: &EntityDecoder<'_>, work: &ExecutionWork<'_>) -> Result<Self, ProgramStop> {
        if let Some(stop) = work_original_stop(decoder, work).map_err(|_| coverage())? { return Err(stop); }
        let authority = Authority::capture(decoder, work).map_err(|_| coverage())?;
        authority.original_stop()?;
        let resources = authority.resources.downcast::<Resources>().ok_or_else(coverage)?;
        resources.reserve_gate().map_err(|stop| authority.stop(stop))?;
        let inner = GateInner { resources: Arc::clone(&resources), source: Arc::downgrade(&authority.source),
            binding: Mutex::new(Binding { current: None, depth: 0 }) };
        Arc::try_new(inner).map(Self).map_err(|_| authority.stop(resources.backend.stop(failure(
            Dimension::LiveBytes, std::mem::size_of::<GateInner>() as u64, 0, RefusalReason::Allocation))))
    }
    pub fn scope<'source, T>(&self, decoder: &mut EntityDecoder<'source>, work: &ExecutionWork<'_>,
        operation: impl FnOnce(&mut EntityDecoder<'source>, &ResourceAllocator) -> Result<T, ProgramStop>)
        -> Result<T, ProgramStop> {
        if let Some(stop) = work_original_stop(decoder, work).map_err(|_| self.record(coverage()))? {
            return Err(stop);
        }
        let authority = Authority::capture(decoder, work).map_err(|_| self.record(coverage()))?;
        authority.original_stop()?;
        let resources = authority.resources.downcast::<Resources>().ok_or_else(|| self.record(coverage()))?;
        if !Arc::ptr_eq(&resources, &self.0.resources) || !self.0.source.upgrade().is_some_and(|source| Arc::ptr_eq(&authority.source, &source)) {
            return Err(self.record(coverage()));
        }
        resources.backend.check()?;
        let previous = {
            let mut state = self.0.binding.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.depth >= MAX_BINDINGS || state.current.as_ref().is_some_and(
                |previous| previous.thread() != std::thread::current().id()) {
                drop(state);
                return Err(self.record(coverage()));
            }
            state.depth += 1;
            state.current.replace(authority)
        };
        let _restore = Restore { gate: Arc::clone(&self.0), previous, _thread_bound: PhantomData };
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
        self.0.resources.backend.check()?;
        let active = authority.ok_or_else(|| self.record(coverage()))?;
        active.validate().map_err(|_| self.record(coverage()))?;
        let live = active.live_resources().map_err(|_| self.record(coverage()))?
            .downcast::<Resources>().ok_or_else(|| self.record(coverage()))?;
        if !Arc::ptr_eq(&live, &self.0.resources) { return Err(self.record(coverage())); }
        self.0.resources.backend.admit(cost).map_err(|stop| self.record(stop))
    }
    pub fn record(&self, stop: ProgramStop) -> ProgramStop {
        let authority = self.current();
        let selected = authority.as_ref().and_then(|active| active.original_stop().err())
            .unwrap_or_else(|| self.0.resources.backend.stop(stop));
        let selected = authority.map_or(selected, |active| active.stop(selected));
        self.0.resources.backend.stop(selected);
        selected
    }
    pub fn backend(&self) -> &Arc<dyn super::backend::Backend> { &self.0.resources.backend }
}
/// Explicit baseline sizes, excluding allocator/RSS overhead. Numeric ABI values
/// are reported only by executed tests. Gate counts include allocator-held refs.
pub(super) fn control_sizes() -> [usize; 8] {
    let (state, epoch) = crate::execution_owner::resource_prototype::metadata_sizes();
    [std::mem::size_of::<Resources>(), std::mem::size_of::<GateInner>(),
        std::mem::size_of::<Authority>(), std::mem::size_of::<Restore>(), state, epoch,
        std::mem::size_of::<ResourceAllocator>(),
        std::mem::size_of::<crate::execution_owner::SourceResourceContext>()]
}
