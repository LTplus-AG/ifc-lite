// SPDX-License-Identifier: MPL-2.0
//! Isolate gate channel forwarding; real-account behavior is witnessed separately.
use super::{fixtures::*, gate::Gate, containers::try_push};
use crate::execution_owner::{AccountedArc, AllocationObserver, SourceResourceContext};
use crate::resource_stop::ProgramStop;
use std::sync::{Mutex, atomic::{AtomicUsize, Ordering}};

struct Recorder { context: SourceResourceContext, terminal: Mutex<Option<ProgramStop>>, records: AtomicUsize }
impl AllocationObserver for Recorder {
    fn account_context(&self) -> Option<SourceResourceContext> { Some(self.context.clone()) }
    fn check(&self) -> Result<(), ProgramStop> {
        self.terminal.lock().unwrap().map_or(Ok(()), Err)
    }
    fn record(&self, stop: ProgramStop) -> ProgramStop {
        self.records.fetch_add(1, Ordering::Relaxed);
        *self.terminal.lock().unwrap().get_or_insert(stop)
    }
}

#[test]
fn early_account_fault_at_gate_construction_and_entry_reaches_captured_observer() {
    use super::backend::Backend;
    for construction in [false, true] {
        run(4096, |decoder, work, _, budget, resources| {
            let context = context(resources);
            let observer = AccountedArc::try_new(Recorder { context: context.clone(),
                terminal: Mutex::new(None), records: AtomicUsize::new(0) }, &context, None).unwrap();
            let gate = if construction { None } else {
                Some(Gate::new_with_observer(decoder, work, Some(observer.observer())).unwrap())
            };
            budget.stop(ProgramStop::Cancelled);
            if let Some(gate) = gate {
                assert_eq!(gate.scope::<()>(decoder, work, |_, _| panic!("stopped account entered")),
                    Err(ProgramStop::Cancelled));
            } else {
                assert!(matches!(Gate::new_with_observer(decoder, work, Some(observer.observer())),
                    Err(ProgramStop::Cancelled)));
            }
            assert_eq!(observer.check(), Err(ProgramStop::Cancelled));
            assert!(observer.records.load(Ordering::Relaxed) > 0);
            assert_eq!(budget.stats().allocations, 0);
        });
    }
}

#[test]
fn account_fault_during_nonallocating_mutation_reaches_captured_observer() {
    use super::backend::Backend;
    run(4096, |decoder, work, _, budget, resources| {
        let context = context(resources);
        let observer = AccountedArc::try_new(Recorder { context: context.clone(),
            terminal: Mutex::new(None), records: AtomicUsize::new(0) }, &context, None).unwrap();
        let gate = Gate::new_with_observer(decoder, work, Some(observer.observer())).unwrap();
        assert_eq!(gate.scope(decoder, work, |_, allocator| {
            let mut values = Vec::new_in(allocator.clone());
            try_push(&mut values, 17u64)?;
            assert!(values.len() < values.capacity());
            let before = budget.stats().allocations;
            budget.stop(ProgramStop::Cancelled);
            assert_eq!(try_push(&mut values, 19), Err(ProgramStop::Cancelled));
            assert_eq!(values.as_slice(), &[17]);
            assert_eq!(budget.stats().allocations, before);
            assert_eq!(observer.check(), Err(ProgramStop::Cancelled));
            drop(values);
            clean(budget);
            Err::<(), _>(ProgramStop::Cancelled)
        }), Err(ProgramStop::Cancelled));
    });
}

#[test]
fn fresh_epoch_reentry_forwards_retained_source_fault_before_independent_account_cancellation() {
    use super::backend::Backend;
    use crate::resource_stop::{Dimension, RefusalReason};
    // The healthy-account arm also proves the retained fault prevents operation
    // entry; the cancelled arm isolates the review's irreversible-epoch defect.
    for cancelled in [false, true] {
        let (source, resources, budget) = setup(65536);
        let mut decoder = source.decoder();
        let mut lease = decoder.try_execution_lease().unwrap();
        let context = context(&resources);
        let observer = AccountedArc::try_new(Recorder { context: context.clone(),
            terminal: Mutex::new(None), records: AtomicUsize::new(0) }, &context, None).unwrap();
        let (gate, original) = {
            let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
            let scope = work.source_borrow_scope_with_resources(Some(context.clone()));
            let gate = Gate::new_with_observer(&decoder, &work, Some(observer.observer())).unwrap();
            gate.scope(&mut decoder, &work, |_, _| Ok(())).unwrap();
            (gate, scope.resource_stop_handle())
        }; // End the healthy work; the next work owns an independent fresh epoch.
        if cancelled { budget.stop(ProgramStop::Cancelled); }
        let fault = super::failure(Dimension::Work, 2, 1, RefusalReason::Limit);
        assert_eq!(original.stop(fault), fault);
        assert_eq!(observer.check(), Ok(()), "no observer has seen either independent fault yet");
        let before = budget.stats();
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let scope = work.source_borrow_scope_with_resources(Some(context.clone()));
        let fresh = scope.resource_stop_handle();
        assert_eq!(fresh.check(), Ok(()));
        assert_eq!(gate.scope::<()>(&mut decoder, &work, |_, _| panic!("retained source fault admitted work")),
            Err(fault));
        assert_eq!(original.check(), Err(fault));
        assert_eq!(observer.check(), Err(fault));
        assert_eq!(fresh.check(), Err(fault), "fresh epoch must not be poisoned with account cancellation");
        assert_eq!(budget.check(), Err(if cancelled { ProgramStop::Cancelled } else { fault }));
        let after = budget.stats();
        assert_eq!((after.live, after.observed, after.work, after.copies, after.allocations,
            after.frees, after.replacements, after.refunded),
            (before.live, before.observed, before.work, before.copies, before.allocations,
                before.frees, before.replacements, before.refunded));
        drop((gate, observer));
        clean(&budget);
    }
}
