// SPDX-License-Identifier: MPL-2.0
//! Actual decoder/work/generation/source-scope authority, not token impersonation.
use super::{backend::{Backend, MAX_BINDINGS, MAX_GATES}, containers::*, fixtures::*, gate::{Gate, control_sizes}};
use crate::{EntityDecoder, SourceBundle};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use std::{alloc::{Allocator, Layout}, sync::Arc};

#[test]
fn r4_account_context_and_waiting_work_without_source_scope_grant_nothing() {
    let (source, resources, budget) = setup(4096);
    let decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    assert!(Gate::new(&decoder, &work).is_err());
    assert_eq!(budget.stats().allocations, 0);
    assert_eq!(resources.retained_gates(), 0);
    let _source = work.source_borrow_scope_with_resources(Some(context(&resources)));
    let gate = Gate::new(&decoder, &work).unwrap();
    drop(gate);
    clean(&budget);
}

#[test]
fn r4_wrong_actual_decoder_and_foreign_source_are_refused_before_allocation() {
    run(4096, |_, work, gate, budget, _| {
        let foreign = SourceBundle::new(b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));".to_vec());
        let mut decoder = foreign.decoder();
        assert!(gate.scope::<()>(&mut decoder, work, |_, _| panic!("wrong owner admitted")).is_err());
        assert_eq!(budget.stats().allocations, 0);
    });
    let (source, resources, budget) = setup(4096);
    let mut borrowed = EntityDecoder::new(source.bytes());
    let mut lease = borrowed.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(borrowed.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    assert!(Gate::new(&borrowed, &work).is_err(), "an actual resource context cannot manufacture bundle authority");
    assert!(borrowed.decode_by_id(1).is_ok(), "raw decoder behavior is unchanged");
    clean(&budget);
}

#[test]
fn r4_actual_generation_and_raw_cache_revision_mutations_invalidate_allocation() {
    for raw_import in [false, true] {
        run(4096, |decoder, work, gate, budget, _| {
            let result = gate.scope(decoder, work, |decoder, allocator| {
                if raw_import { decoder.set_point_cache(Default::default()); }
                else { decoder.seed_unit_scales(1., 1.); }
                assert!(allocator.allocate(Layout::new::<u64>()).is_err());
                assert_eq!(budget.stats().allocations, 0);
                Err::<(), _>(allocator.error())
            });
            assert!(matches!(result, Err(ProgramStop::ResourceRefused(failure))
                if failure.dimension == Dimension::Coverage));
        });
    }
}

#[test]
fn r4_live_work_cannot_allocate_after_its_published_source_scope_ends() {
    let (source, resources, budget) = setup(4096);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let source_scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    let gate = Gate::new(&decoder, &work).unwrap();
    let result = gate.scope(&mut decoder, &work, |_, allocator| {
        drop(source_scope);
        assert!(allocator.allocate(Layout::new::<u64>()).is_err());
        Err::<(), _>(allocator.error())
    });
    assert!(result.is_err());
    assert_eq!(budget.stats().allocations, 0);
}

#[test]
fn r4_reentry_restores_previous_binding_without_tls_or_new_gate() {
    run(4096, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |decoder, allocator| {
            let count = budget.stats().allocations;
            gate.scope(decoder, work, |_, nested| {
                let values = try_box_slice(nested, 2, |_| Ok(7u64))?;
                assert_eq!(values.as_ref(), &[7, 7]);
                drop(values);
                Ok(())
            })?;
            let outer = try_arc(allocator, 9u64)?;
            assert_eq!(*outer, 9);
            drop(outer);
            assert_eq!(budget.stats().allocations, count + 2);
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn r4_cleanup_transfer_to_next_actual_decoder_rebinds_work_not_refund_account() {
    let (source, resources, budget) = setup(65536);
    let (gate, mut owner) = {
        let mut first = source.decoder();
        let mut lease = first.try_execution_lease().unwrap();
        let work = lease.begin_synchronous_work(first.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
        let gate = Gate::new(&first, &work).unwrap();
        let owner = gate.scope(&mut first, &work, |_, allocator| {
            let mut values = Vec::new_in(allocator.clone());
            try_push(&mut values, 1u64)?;
            Ok(CleanupOwner(Some(values)))
        }).unwrap();
        (gate, owner)
    };
    let mut handoff = CleanupOwner::empty();
    drop(handoff.replace_for_cleanup(owner.take_for_cleanup())); // old work expired
    let before = budget.stats().allocations;
    let mut second = source.decoder();
    let mut lease = second.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(second.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    gate.scope(&mut second, &work, |_, _| {
        let values = handoff.0.as_mut().unwrap();
        for id in 2..100 { try_push(values, id)?; }
        assert_eq!(values.len(), 99);
        Ok(())
    }).unwrap();
    assert!(budget.stats().allocations + budget.stats().replacements > before);
    drop(handoff.take_for_cleanup());
    clean(&budget);
}

#[test]
fn r4_same_source_with_another_backend_cannot_reassign_existing_refunds() {
    let (source, resources, budget) = setup(4096);
    let gate = {
        let decoder = source.decoder();
        let mut lease = decoder.try_execution_lease().unwrap();
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
        Gate::new(&decoder, &work).unwrap()
    };
    let (_, other, other_budget) = setup(4096);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&other)));
    assert!(gate.scope::<()>(&mut decoder, &work, |_, _| panic!("foreign account admitted")).is_err());
    assert_eq!(budget.stats().allocations, 0);
    assert_eq!(other_budget.stats().allocations, 0);
}

#[test]
fn r4_ancestor_original_stop_wins_over_backend_and_capacity_failure() {
    let (source, resources, budget) = setup(4096);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    let gate = Gate::new(&decoder, &work).unwrap();
    gate.scope(&mut decoder, &work, |_, allocator| {
        scope.resource_stop_handle().stop(ProgramStop::Cancelled);
        budget.stop(super::failure(Dimension::Work, 9, 0, RefusalReason::Limit));
        assert!(matches!(try_box_slice::<u64>(allocator, usize::MAX, |_| unreachable!()),
            Err(ProgramStop::Cancelled)));
        Err::<(), _>(ProgramStop::Cancelled)
    }).unwrap_err();
    assert_eq!(budget.stats().allocations, 0);
}

#[test]
fn r4_control_metadata_has_fixed_slots_and_reports_real_abi_sizes() {
    let resources = run(4096, |decoder, work, _, budget, resources| {
        assert_eq!(resources.retained_gates(), 1);
        let mut extras = Vec::new();
        for _ in 1..MAX_GATES { extras.push(Gate::new(decoder, work).unwrap()); }
        assert!(Gate::new(decoder, work).is_err());
        assert_eq!(resources.retained_gates(), MAX_GATES);
        assert_eq!(budget.stats().allocations, 0, "control envelope is distinct from requested source Layouts");
        drop(extras);
        assert_eq!(resources.retained_gates(), 1);
        eprintln!("R4 control sizes [resources, gate, authority, restore, state, epoch, allocator, context]={:?}; backend={}; gates={MAX_GATES}; frames={MAX_BINDINGS}",
            control_sizes(), std::mem::size_of::<Budget>());
        Arc::clone(resources)
    });
    assert_eq!(resources.retained_gates(), 0);
}

#[test]
fn r4_joined_source_worker_uses_actual_decoder_and_observes_ancestor_expiry() {
    for expire in [false, true] {
        let (source, resources, budget) = setup(4096);
        let mut decoder = source.decoder();
        let mut lease = decoder.try_execution_lease().unwrap();
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _source = work.source_borrow_scope_with_resources(Some(context(&resources)));
        let gate = Gate::new(&decoder, &work).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        std::thread::scope(|threads| {
            let decoder = &mut decoder;
            let gate = gate.clone();
            let worker = threads.spawn(move || {
                let mut child = decoder.try_source_execution_lease().unwrap().unwrap();
                let resource_context = child.source_resource_context().unwrap();
                let child_work = child.begin_synchronous_work(decoder.execution_identity()).unwrap();
                let _child_source = child_work.source_borrow_scope_with_resources(resource_context);
                gate.scope(decoder, &child_work, |_, allocator| {
                    let first = try_arc(allocator, 4u64)?;
                    ready_tx.send(()).unwrap();
                    continue_rx.recv().unwrap();
                    let next = try_arc(allocator, 8u64);
                    drop(first); // cleanup even when parent epoch expired
                    next.map(drop)
                })
            });
            ready_rx.recv().unwrap();
            if expire { drop(work); }
            continue_tx.send(()).unwrap();
            let result = worker.join().unwrap();
            assert_eq!(result.is_err(), expire);
        });
        clean(&budget);
    }
}

#[test]
fn r4_retained_allocator_and_shadow_resource_scope_do_not_grant_new_work() {
    run(4096, |decoder, work, gate, budget, _| {
        let allocator = gate.scope(decoder, work, |_, allocator| Ok(allocator.clone())).unwrap();
        assert!(allocator.allocate(Layout::new::<u64>()).is_err(), "no active gate binding");
        assert_eq!(budget.stats().allocations, 0);
    });
    run(4096, |decoder, work, gate, budget, _| {
        let (_, unrelated, unrelated_budget) = setup(4096);
        assert!(gate.scope(decoder, work, |_, allocator| {
            let _shadow = work.source_borrow_scope_with_resources(Some(context(&unrelated)));
            assert!(allocator.allocate(Layout::new::<u64>()).is_err());
            Err::<(), _>(allocator.error())
        }).is_err());
        assert_eq!(budget.stats().allocations, 0);
        assert_eq!(unrelated_budget.stats().allocations, 0);
    });
}

#[test]
fn r4_binding_frame_limit_unwinds_without_allocating_control_history() {
    fn nested(depth: usize, decoder: &mut EntityDecoder<'_>,
        work: &crate::execution_owner::ExecutionWork<'_>, gate: &Gate) -> Result<(), ProgramStop> {
        if depth == 0 { return Ok(()); }
        gate.scope(decoder, work, |decoder, _| nested(depth - 1, decoder, work, gate))
    }
    run(4096, |decoder, work, gate, budget, resources| {
        assert!(nested(MAX_BINDINGS + 1, decoder, work, gate).is_err());
        assert_eq!(budget.stats().allocations, 0);
        assert_eq!(resources.retained_gates(), 1);
        clean(budget);
    });
}

#[test]
fn r4_existing_original_stop_survives_stale_configuration_at_gate_entry() {
    let (source, resources, budget) = setup(4096);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    let gate = Gate::new(&decoder, &work).unwrap();
    scope.resource_stop_handle().stop(ProgramStop::Cancelled);
    decoder.set_point_cache(Default::default());
    assert_eq!(gate.scope::<()>(&mut decoder, &work, |_, _| panic!("stale stopped owner admitted")),
        Err(ProgramStop::Cancelled));
    assert_eq!(budget.stats().allocations, 0);
}

#[test]
fn r4_same_bytes_and_same_backend_do_not_admit_a_foreign_source_load() {
    let (source, resources, budget) = setup(4096);
    let gate = {
        let decoder = source.decoder();
        let mut lease = decoder.try_execution_lease().unwrap();
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
        Gate::new(&decoder, &work).unwrap()
    };
    let foreign = SourceBundle::new(source.bytes().to_vec());
    let mut decoder = foreign.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    assert!(gate.scope::<()>(&mut decoder, &work, |_, _| panic!("foreign load admitted")).is_err());
    assert_eq!(budget.stats().allocations, 0);
}
