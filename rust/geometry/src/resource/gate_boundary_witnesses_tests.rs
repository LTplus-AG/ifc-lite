// SPDX-License-Identifier: MPL-2.0
//! Combined SAME normal-core private gate and actual geometry account witnesses.
use crate::resource::{self as resource, ExecutionAccount, ExecutionPolicy, ResourceLimits,
    ModelResourcePool, RequestAdmission, OwnedResourceContext, Usage, ProgramStop, Dimension,
    RefusalReason, ResourceFailure};
use ifc_lite_core::{execution_owner::AllocationObserverHandle,
    source_resource_gate_test_support::{run_gate_witness, GateWitnessCase as Case,
        GateWitnessStage as Stage, GateWitnessReport}};
use std::{cell::RefCell, rc::Rc};

type ObserverSlot = Rc<RefCell<Option<AllocationObserverHandle>>>;
#[derive(Clone, Copy)]
struct Snapshot { usage: Usage, container: u64, metadata: u64 }
#[derive(Default)]
struct Captured {
    account_stop: Option<ProgramStop>, before: Option<Snapshot>, after: Option<Snapshot>,
}
struct Instrumentation {
    account: Option<ExecutionAccount>, observer: ObserverSlot, pool: ModelResourcePool,
    foreign: ExecutionAccount, case: Case, cancelled: bool,
    snapshots: [Option<Snapshot>; 13], captured: Rc<RefCell<Captured>>,
}
fn fault(dimension: Dimension, requested: u64) -> ProgramStop {
    ProgramStop::ResourceRefused(ResourceFailure { dimension, requested, remaining: 1, reason: RefusalReason::Limit })
}
impl Instrumentation {
    fn snapshot(&self, stage: Stage) -> Snapshot { self.snapshots[stage as usize].unwrap() }
    fn simulated_ledger(&self, before: Snapshot, after: Snapshot) {
        assert_eq!(after.container, before.container, "only provisional new backing was refunded");
        assert_eq!(after.usage.live_bytes, before.usage.live_bytes);
        if self.case == Case::SimulatedPreStopped {
            assert_eq!(after.usage, before.usage, "source refusal precedes debit and fixture consumption");
        } else {
            assert_eq!(after.usage.work, before.usage.work + 2, "operation and attempted allocation remain charged");
            if self.case == Case::SimulatedFresh {
                assert_eq!(after.usage.copy_bytes, before.usage.copy_bytes);
            } else {
                assert!(after.usage.copy_bytes > before.usage.copy_bytes);
                // Exact old Layout is derived independently at WeakOnly.
            }
            // Exact peak is checked after the runner returns its independently
            // recorded requested Layout; do not guess Vec growth/capacity here.
        }
    }
    fn observe(&mut self, stage: Stage) {
        assert_eq!(self.foreign.usage(), Usage::default(), "ambient allowance must never be selected");
        if stage == Stage::ReleaseExternalOwners {
            let observer = self.observer.borrow_mut().take();
            drop(observer);
            drop(self.account.take());
            return;
        }
        if matches!(stage, Stage::OnlyWeakRetains | Stage::AfterFinalWeak) {
            assert!(self.account.is_none());
            assert!(self.observer.borrow().is_none());
            assert_eq!(self.pool.resident_bytes(), if stage == Stage::OnlyWeakRetains { 32768 } else { 0 });
            return;
        }
        let account = self.account.as_ref().unwrap();
        if stage == Stage::InjectFault {
            // Factory already captured a healthy actual observer. Never check it
            // after cancellation until core has established retained source F.
            if self.cancelled {
                account.cancel();
                assert_eq!(account.check(), Err(ProgramStop::Cancelled));
            }
            if self.case == Case::PreStoppedObserver {
                let observer = self.observer.borrow().as_ref().unwrap().clone();
                assert_eq!(observer.record(fault(Dimension::OutputBytes, 4)), fault(Dimension::OutputBytes, 4));
            }
        }
        let (container, metadata) = account.allocation_usage();
        let current = Snapshot { usage: account.usage(), container, metadata };
        assert_eq!(current.usage.live_bytes, container + metadata);
        self.snapshots[stage as usize] = Some(current);
        match stage {
            Stage::ObserverFunded => { assert_eq!(container, 0); assert!(metadata > 0); }
            Stage::GateFunded => {
                assert_eq!(container, 0);
                assert!(metadata > self.snapshot(Stage::ObserverFunded).metadata, "gate and observer have distinct funded backing");
            }
            Stage::ContainerLive => {
                assert!(container > 0);
                assert_eq!(metadata, self.snapshot(Stage::GateFunded).metadata);
            }
            Stage::AfterSharing => {
                assert_eq!(current.usage, self.snapshot(Stage::BeforeSharing).usage);
            }
            Stage::AfterGrow => {
                let before = self.snapshot(Stage::BeforeGrow);
                self.captured.borrow_mut().before = Some(before);
                self.captured.borrow_mut().after = Some(current);
                assert_eq!(metadata, before.metadata);
                if is_simulated(self.case) {
                    self.simulated_ledger(before, current);
                    return;
                }
                assert!(current.usage.work > before.usage.work);
                assert!(current.usage.copy_bytes > before.usage.copy_bytes);
                if self.case == Case::RefusedGrowth {
                    assert_eq!(container, before.container);
                    assert_eq!(current.usage.live_bytes, before.usage.live_bytes);
                    assert!(matches!(account.check(), Err(ProgramStop::ResourceRefused(failure))
                        if failure.dimension == Dimension::LiveBytes && failure.reason == RefusalReason::Limit));
                } else {
                    // Growth admits full new Vec backing while its old allocation
                    // is still charged. The new allocation is >=256 u64 elements.
                    assert!(current.usage.peak_live_bytes >= before.usage.live_bytes + 256 * 8);
                    assert!(container > before.container);
                }
            }
            Stage::TerminalObserved => {
                // Independent actual account observation, retained as scalars
                // after every account/context clone must have been dropped.
                let observed = account.check().err();
                self.captured.borrow_mut().account_stop = observed;
                let expected = match self.case {
                    Case::Lifetime => Some(None),
                    Case::ExpiredWork => {
                        assert_eq!(current.usage, self.snapshot(Stage::AfterGrow).usage,
                            "expired spare-capacity mutation must not reach allocation or admission");
                        Some(Some(ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Coverage,
                            requested: 0, remaining: 0, reason: RefusalReason::UnsupportedCoverage })))
                    }
                    Case::FreshFault | Case::PreStoppedEpoch => Some(Some(if self.cancelled {
                        ProgramStop::Cancelled
                    } else { fault(Dimension::Work, 2) })),
                    Case::PreStoppedObserver => Some(Some(fault(Dimension::OutputBytes, 4))),
                    Case::SimulatedSourceGrow | Case::SimulatedPreStopped => Some(Some(fault(Dimension::Work, 2))),
                    // Complete comparison to operation_stop occurs after return;
                    // the expected value must never be this same account read.
                    Case::RefusedGrowth | Case::SimulatedFresh | Case::SimulatedGrow => None,
                };
                if let Some(expected) = expected { assert_eq!(observed, expected); }
            }
            Stage::WeakOnly => {
                let before = self.snapshot(Stage::AfterGrow);
                assert!(container > 0, "actual Arc allocation survives while Weak cannot upgrade");
                assert!(container < before.container, "nested Vec backing was already freed");
                assert_eq!(metadata, before.metadata, "Weak allocator retains both gate and observer backing");
                let old_bytes = self.snapshot(Stage::BeforeGrow).container - container;
                assert!(old_bytes > 0);
                let copied = if matches!(self.case, Case::SimulatedFresh | Case::SimulatedPreStopped) { 0 } else { old_bytes };
                assert_eq!(before.usage.copy_bytes - self.snapshot(Stage::BeforeGrow).usage.copy_bytes, copied);
                if self.case != Case::RefusedGrowth && !is_simulated(self.case) {
                    assert!(before.usage.peak_live_bytes >= before.usage.live_bytes + old_bytes,
                        "full old Vec Layout overlaps the new actual backing");
                }
            }
            _ => {}
        }
    }
}
fn is_simulated(case: Case) -> bool {
    matches!(case, Case::SimulatedFresh | Case::SimulatedGrow | Case::SimulatedSourceGrow | Case::SimulatedPreStopped)
}
fn run_case(case: Case, cancelled: bool) -> GateWitnessReport {
    let pool = ModelResourcePool::new(32768);
    let account = match pool.admit(ResourceLimits { live_bytes: Some(32768), ..Default::default() }).unwrap() {
        RequestAdmission::Ready(account) => account,
        RequestAdmission::WaitingForCapacity => panic!("new pool has no resident requests"),
    };
    let context = account.source_context().unwrap();
    assert!(context.is_accounted());
    let for_observer = context.clone();
    let observer: ObserverSlot = Rc::new(RefCell::new(None));
    let factory_observer = observer.clone();
    let foreign = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let captured = Rc::new(RefCell::new(Captured::default()));
    let mut instrumentation = Instrumentation { account: Some(account), observer, pool: pool.clone(),
        foreign: foreign.clone(), case, cancelled, snapshots: [None; 13], captured: captured.clone() };
    let report = foreign.scope(|| run_gate_witness(case, context, move |stop| {
        let owned = OwnedResourceContext::try_capture_accounted(&for_observer, stop)?;
        owned.check()?;
        let observer = owned.allocation_observer().unwrap();
        assert!(factory_observer.borrow_mut().replace(observer.clone()).is_none());
        Ok(observer)
    }, move |stage| instrumentation.observe(stage))).unwrap();
    assert_eq!(pool.resident_bytes(), 0, "every original account/context/observer/callback capture must be gone");
    assert_eq!(foreign.usage(), Usage::default());
    assert_eq!(resource::check_current(), Ok(()));
    assert!(report.values_preserved);
    assert!(report.weak_cannot_upgrade);
    let captured = captured.borrow();
    if matches!(case, Case::RefusedGrowth | Case::SimulatedFresh | Case::SimulatedGrow) {
        assert_eq!(captured.account_stop, report.operation_stop,
            "actual account must retain the complete operation stop independently of source/observer");
    }
    if is_simulated(case) {
        exact_simulated_peak(case, &report, &captured);
    }
    report
}
fn exact_simulated_peak(case: Case, report: &GateWitnessReport, captured: &Captured) {
    let before = captured.before.unwrap();
    let after = captured.after.unwrap();
    if case == Case::SimulatedPreStopped {
        assert_eq!(report.requested_layout_bytes, 0, "source refused before delegation boundary");
        assert_eq!(after.usage, before.usage);
    } else {
        let requested = u64::try_from(report.requested_layout_bytes).unwrap();
        assert!(requested > 0);
        assert_eq!(after.usage.peak_live_bytes,
            before.usage.peak_live_bytes.max(before.usage.live_bytes.checked_add(requested).unwrap()),
            "peak retains the full actual requested Layout, including old/new overlap");
    }
}
/// Actual container, gate and observer debits; sharing, growth, Weak and final pool release.
pub fn actual_gate_lifetime_witness() {
    let report = run_case(Case::Lifetime, false);
    assert!(report.new_capacity > report.old_capacity);
    assert!(report.operation_stop.is_none());
    assert!(report.original_stop.is_none());
    assert!(report.observer_stop.is_none());
}
/// Refused overlap preserves actual backing and attempted work in the real ledger.
pub fn actual_gate_refused_growth_witness() {
    let report = run_case(Case::RefusedGrowth, false);
    assert_eq!(report.new_capacity, report.old_capacity);
    assert!(report.refused_pointer_preserved);
    assert_eq!(report.original_stop, report.operation_stop);
    assert_eq!(report.observer_stop, report.operation_stop);
}
/// Healthy real account cannot mutate spare capacity after authenticated work ends.
pub fn actual_gate_expired_work_witness() {
    let report = run_case(Case::ExpiredWork, false);
    assert!(report.refused_pointer_preserved);
    assert!(matches!(report.returned_stop, Some(ProgramStop::ResourceRefused(failure))
        if failure.dimension == Dimension::Coverage && failure.reason == RefusalReason::UnsupportedCoverage));
    assert_eq!(report.original_stop, report.returned_stop);
    assert_eq!(report.observer_stop, report.returned_stop);
}
/// Fresh epochs agree on F; independently stopped epochs retain their own first fault.
pub fn actual_gate_first_fault_witness() {
    for cancelled in [false, true] {
        let report = run_case(Case::FreshFault, cancelled);
        let f = Some(fault(Dimension::Work, 2));
        assert_eq!((report.attempted_original_stop, report.returned_stop, report.original_stop,
            report.fresh_stop, report.observer_stop), (f, f, f, f, f));
        assert!(!report.fresh_operation_entered);
    }
    let report = run_case(Case::PreStoppedEpoch, true);
    let f = Some(fault(Dimension::Work, 2));
    assert_eq!((report.returned_stop, report.original_stop, report.observer_stop), (f, f, f));
    assert_eq!(report.fresh_stop, Some(fault(Dimension::CopyBytes, 3)));
    assert!(!report.fresh_operation_entered);
    let report = run_case(Case::PreStoppedObserver, false);
    let o = Some(fault(Dimension::OutputBytes, 4));
    // Actual OwnedState record propagates O into its captured original source
    // and account; a later attempted F cannot rewrite any of those first faults.
    assert_eq!((report.attempted_original_stop, report.returned_stop, report.original_stop,
        report.observer_stop), (o, o, o, o));
    assert_eq!(report.fresh_stop, o);
    assert!(!report.fresh_operation_entered);
}
/// Simulated delegation errors: no Global call, no candidate block, no OOM claim.
pub fn actual_gate_simulated_delegation_witness() {
    for case in [Case::SimulatedFresh, Case::SimulatedGrow, Case::SimulatedSourceGrow, Case::SimulatedPreStopped] {
        let report = run_case(case, false);
        assert_eq!(report.new_capacity, report.old_capacity);
        assert!(report.refused_pointer_preserved);
        assert_eq!(report.original_stop, report.operation_stop);
        assert_eq!(report.observer_stop, report.operation_stop);
        let prevented = case == Case::SimulatedPreStopped;
        assert_eq!(report.simulated_errors, if prevented { 0 } else { 1 });
        assert_eq!(report.injection_still_armed, prevented);
        assert_eq!(report.returned_stop, report.operation_stop);
        assert_eq!(report.fresh_stop, report.operation_stop);
        assert!(!report.fresh_operation_entered);
        if case == Case::SimulatedFresh { assert!(report.fresh_backing_absent); }
        if matches!(case, Case::SimulatedSourceGrow | Case::SimulatedPreStopped) {
            let f = Some(fault(Dimension::Work, 2));
            assert_eq!((report.operation_stop, report.returned_stop, report.fresh_stop), (f, f, f));
            assert!(!report.fresh_operation_entered);
        } else {
            assert!(matches!(report.operation_stop, Some(ProgramStop::ResourceRefused(failure))
                if failure.reason == RefusalReason::Allocation && failure.dimension == Dimension::LiveBytes));
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn actual_gate_simulated_delegation() { super::actual_gate_simulated_delegation_witness(); }
    #[test]
    fn actual_gate_lifetime() { super::actual_gate_lifetime_witness(); }
    #[test]
    fn actual_gate_refused_growth() { super::actual_gate_refused_growth_witness(); }
    #[test]
    fn actual_gate_expired_work() { super::actual_gate_expired_work_witness(); }
    #[test]
    fn actual_gate_first_fault() { super::actual_gate_first_fault_witness(); }
}
