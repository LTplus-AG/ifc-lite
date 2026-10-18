// SPDX-License-Identifier: MPL-2.0
//! Optional ordered identities of registry processors actually entered by a
//! synchronous work slice. This is sparse dispatch evidence, not a census:
//! direct constructors, boolean factories and contextual paths may bypass it.
use super::ConstructionFamily;
use std::{cell::RefCell, collections::HashSet, marker::PhantomData,
    sync::atomic::{AtomicU64, Ordering}};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct ProcessorEmitterId(u64);
impl ProcessorEmitterId {
    pub(super) fn fresh() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
            |next| next.checked_add(1)).expect("processor emitter identities exhausted"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessorEmitterOrigin { Builtin, ConfiguredBuiltin, Custom }

/// Process-local identity of the selected live processor instance/registration.
/// Aliases of one registration share identity; a replacement receives a new one.
/// An identity is not a model id, arithmetic guarantee or standalone work lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessorEmitter {
    pub(super) id: ProcessorEmitterId,
    pub(super) origin: ProcessorEmitterOrigin,
    pub(super) family: Option<ConstructionFamily>,
}
impl ProcessorEmitter {
    pub fn origin(self) -> ProcessorEmitterOrigin { self.origin }
    /// Built-in implementation family; custom advertised IFC aliases do not
    /// establish built-in semantics and therefore have no family here.
    pub fn family(self) -> Option<ConstructionFamily> { self.family }
}

#[derive(Debug, Default)]
struct Trace {
    ordered: Vec<ProcessorEmitter>,
    seen: HashSet<ProcessorEmitterId>,
}
thread_local! {
    static ACTIVE: RefCell<Option<Trace>> = const { RefCell::new(None) };
}
pub(super) fn enabled() -> bool { ACTIVE.with(|active| active.borrow().is_some()) }
pub(super) fn record(emitter: ProcessorEmitter) {
    ACTIVE.with(|active| {
        if let Some(trace) = active.borrow_mut().as_mut() {
            if trace.seen.insert(emitter.id) { trace.ordered.push(emitter); }
        }
    });
}

/// Optional sparse capture, ordered by first actual entry and unique per live
/// emitter. It neither initializes processors nor drains their diagnostic logs.
/// Separate captures can interleave on independent worker owners; nested scopes
/// restore their caller's trace without merging independently owned captures.
#[derive(Debug, Default)]
pub struct ProcessorDispatchCapture { trace: Trace }
impl ProcessorDispatchCapture {
    pub fn new() -> Self { Self::default() }

    pub fn capture<T>(work: impl FnOnce() -> T) -> (T, Vec<ProcessorEmitter>) {
        let mut capture = Self::new();
        let result = capture.with_scope(work);
        (result, capture.take())
    }

    /// Retain identities even when work unwinds, while restoring caller TLS.
    /// Use an externally owned capture when a panic is caught outside this
    /// call and a failed-work terminal packet must keep its emitter evidence.
    pub fn with_scope<T>(&mut self, work: impl FnOnce() -> T) -> T {
        let caller = ACTIVE.with(|active| active.replace(Some(std::mem::take(&mut self.trace))));
        let _scope = Scope { capture: self, caller, _thread_bound: PhantomData };
        work()
    }

    pub fn take(&mut self) -> Vec<ProcessorEmitter> {
        self.trace.seen.clear();
        std::mem::take(&mut self.trace.ordered)
    }
}
struct Scope<'a> {
    capture: &'a mut ProcessorDispatchCapture,
    caller: Option<Trace>,
    _thread_bound: PhantomData<*const ()>,
}
impl Drop for Scope<'_> {
    fn drop(&mut self) {
        self.capture.trace = ACTIVE.with(|active|
            active.replace(self.caller.take()).expect("active processor dispatch scope"));
    }
}

#[cfg(test)]
#[path = "dispatch_capture_tests.rs"]
mod tests;
