// SPDX-License-Identifier: MPL-2.0
//! Fixed fixtures in the normal core type universe; no production entry point.
use super::{coverage, gate::Gate, containers::CleanupOwner, witness_operations as operations};
use crate::{SourceBundle, execution_owner::{SourceResourceContext, SourceStopHandle,
    AllocationObserverHandle}, resource_stop::{ProgramStop, Dimension, RefusalReason}};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GateWitnessCase {
    #[default] Lifetime, RefusedGrowth, ExpiredWork, FreshFault, PreStoppedEpoch, PreStoppedObserver,
}
/// Trusted instrumentation identifiers. No owner or execution capability is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateWitnessStage {
    ObserverFunded, GateFunded, ContainerLive, BeforeSharing, AfterSharing,
    BeforeGrow, AfterGrow, InjectFault, TerminalObserved, WeakOnly,
    ReleaseExternalOwners, OnlyWeakRetains, AfterFinalWeak,
}
#[derive(Debug, Clone, Copy, Default)]
pub struct GateWitnessReport {
    pub case: GateWitnessCase,
    pub old_capacity: usize, pub new_capacity: usize,
    pub values_preserved: bool, pub refused_pointer_preserved: bool,
    pub weak_cannot_upgrade: bool,
    pub operation_stop: Option<ProgramStop>, pub attempted_original_stop: Option<ProgramStop>,
    pub returned_stop: Option<ProgramStop>, pub original_stop: Option<ProgramStop>,
    pub fresh_stop: Option<ProgramStop>, pub observer_stop: Option<ProgramStop>,
    pub fresh_operation_entered: bool,
}
/// Run one fixed, bounded fixture. The only resource input is the original paired
/// context. The factory is consumed ONCE inside healthy actual published work.
/// Callbacks are trusted test instrumentation, not mechanically bounded arbitrary
/// Rust: do not recurse into this runner, select accounts, or perform decoder work.
/// Stage callbacks run outside locks and receive no owner handles. Before final
/// Weak release, ReleaseExternalOwners MUST discard all external original account,
/// context and observer clones, including callback captures. No capability escapes.
/// Ordinary tracking/default builds do not expose this function or private gate.
pub fn run_gate_witness(case: GateWitnessCase, context: SourceResourceContext,
    observer_factory: impl FnOnce(SourceStopHandle) -> Result<AllocationObserverHandle, ProgramStop>,
    mut observe: impl FnMut(GateWitnessStage)) -> Result<GateWitnessReport, ProgramStop> {
    let mut report = GateWitnessReport { case, ..Default::default() };
    let weak = {
        let source = SourceBundle::new(b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));".to_vec());
        let mut decoder = source.decoder();
        let mut lease = decoder.try_execution_lease().map_err(|_| coverage())?;
        let work = lease.begin_synchronous_work(decoder.execution_identity()).map_err(|_| coverage())?;
        let scope = work.source_borrow_scope_with_resources(Some(context.clone()));
        let original = scope.resource_stop_handle();
        original.check()?;
        context.allocation_account().ok_or_else(coverage)?.check().map_err(|stop| original.stop(stop))?;
        let observer = observer_factory(original.clone())?;
        observe(GateWitnessStage::ObserverFunded);
        let gate = Gate::new_with_observer(&decoder, &work, Some(observer.clone()))?;
        observe(GateWitnessStage::GateFunded);
        let mut payload = None;
        let result = gate.scope(&mut decoder, &work, |_, allocator| {
            payload = Some(operations::create(allocator, &mut observe)?);
            operations::grow(payload.as_mut().ok_or_else(coverage)?, allocator, &mut report, &mut observe)
        });
        report.operation_stop = result.err();
        if case == GateWitnessCase::RefusedGrowth {
            if !matches!(report.operation_stop, Some(ProgramStop::ResourceRefused(failure))
                if failure.dimension == Dimension::LiveBytes && failure.reason == RefusalReason::Limit) {
                return Err(coverage());
            }
        } else if let Some(stop) = report.operation_stop { return Err(stop); }
        drop(scope);
        drop(work);
        if case == GateWitnessCase::ExpiredWork {
            let (stop, preserved) = operations::expired_mutation(payload.as_mut().ok_or_else(coverage)?)?;
            report.returned_stop = stop;
            report.refused_pointer_preserved = preserved;
            report.values_preserved &= preserved;
        }
        if matches!(case, GateWitnessCase::FreshFault | GateWitnessCase::PreStoppedEpoch | GateWitnessCase::PreStoppedObserver) {
            observe(GateWitnessStage::InjectFault);
            let fault = super::failure(Dimension::Work, 2, 1, RefusalReason::Limit);
            report.attempted_original_stop = Some(original.stop(fault));
            let work = lease.begin_synchronous_work(decoder.execution_identity()).map_err(|_| coverage())?;
            let scope = work.source_borrow_scope_with_resources(Some(context.clone()));
            let fresh = scope.resource_stop_handle();
            if case == GateWitnessCase::PreStoppedEpoch {
                fresh.stop(super::failure(Dimension::CopyBytes, 3, 1, RefusalReason::Limit));
            }
            report.returned_stop = gate.scope(&mut decoder, &work, |_, _| {
                report.fresh_operation_entered = true;
                Ok(())
            }).err();
            report.fresh_stop = fresh.check().err();
        }
        report.original_stop = original.check().err();
        report.observer_stop = observer.check().err();
        observe(GateWitnessStage::TerminalObserved);
        let payload = payload.ok_or_else(coverage)?;
        let weak = Arc::downgrade(&payload);
        // The SAME cleanup-only moves used by unit tests operate after work ends.
        let mut owned = CleanupOwner(Some(payload));
        let mut destination = CleanupOwner::empty();
        drop(destination.replace_for_cleanup(owned.take_for_cleanup()));
        drop(destination.take_for_cleanup());
        drop((gate, observer));
        weak
    }; // Every decoder, lease, scope, original stop and local observer is gone.
    report.weak_cannot_upgrade = weak.upgrade().is_none();
    drop(context);
    observe(GateWitnessStage::WeakOnly);
    observe(GateWitnessStage::ReleaseExternalOwners);
    observe(GateWitnessStage::OnlyWeakRetains);
    drop(weak); // Actual container free -> gate/observer metadata free -> pool release.
    observe(GateWitnessStage::AfterFinalWeak);
    Ok(report)
}
