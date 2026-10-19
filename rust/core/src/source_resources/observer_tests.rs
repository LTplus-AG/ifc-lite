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
