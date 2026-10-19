// SPDX-License-Identifier: MPL-2.0
//! Fixed real-container operations, using the same private adapters as unit tests.
use super::{allocator::ResourceAllocator, containers::*, coverage,
    witness::{GateWitnessCase, GateWitnessReport, GateWitnessStage}};
use crate::resource_stop::ProgramStop;
use std::sync::Arc;

type Payload = Arc<Vec<u64, ResourceAllocator>, ResourceAllocator>;
pub(super) fn create(allocator: &ResourceAllocator, observe: &mut impl FnMut(GateWitnessStage))
    -> Result<Payload, ProgramStop> {
    let mut values = Vec::new_in(allocator.clone());
    try_push(&mut values, 17u64)?;
    try_push(&mut values, 19)?;
    let boxed = try_box_slice(allocator, 2, |index| Ok(index as u64 + 3))?;
    let mut cache = empty_cache(allocator);
    try_import_copy(&mut cache, &[(1, 7), (2, 8), (1, 9)])?;
    if try_insert(&mut cache, 2, 10)? != Some(8) || try_insert(&mut cache, 3, 11)?.is_some()
        || cache.get(&1) != Some(&9) || boxed.as_ref() != [3, 4] {
        return Err(coverage());
    }
    drop((boxed, cache));
    let payload = try_arc(allocator, values)?;
    observe(GateWitnessStage::ContainerLive);
    observe(GateWitnessStage::BeforeSharing);
    let alias = payload.clone();
    let weak = Arc::downgrade(&payload);
    let upgraded = weak.upgrade().ok_or_else(coverage)?;
    drop((alias, weak, upgraded));
    observe(GateWitnessStage::AfterSharing);
    Ok(payload)
}
pub(super) fn grow(payload: &mut Payload, allocator: &ResourceAllocator,
    report: &mut GateWitnessReport, observe: &mut impl FnMut(GateWitnessStage)) -> Result<(), ProgramStop> {
    let values = Arc::get_mut(payload).ok_or_else(coverage)?;
    report.old_capacity = values.capacity();
    let old_pointer = values.as_ptr();
    observe(GateWitnessStage::BeforeGrow);
    if matches!(report.case, GateWitnessCase::SimulatedFresh | GateWitnessCase::SimulatedGrow
        | GateWitnessCase::SimulatedSourceGrow | GateWitnessCase::SimulatedPreStopped) {
        return simulated_failure(values, allocator, report, observe, old_pointer);
    }
    allocator.enter_operation()?;
    // Fixed maximum request: ~64 KiB, not an arbitrary supplied workload. The
    // geometry refusal witness uses a 32 KiB actual allowance, so Global is not
    // reached by the refused request. Successful growth is only ~2 KiB.
    let additional = if report.case == GateWitnessCase::RefusedGrowth { 8192 } else { 256 };
    let result = values.try_reserve(additional).map_err(|error| allocator.reserve_error(error));
    report.new_capacity = values.capacity();
    report.values_preserved = values.as_slice() == [17, 19];
    report.refused_pointer_preserved = result.is_err() && values.as_ptr() == old_pointer;
    observe(GateWitnessStage::AfterGrow);
    result
}
pub(super) fn expired_mutation(payload: &mut Payload) -> Result<(Option<ProgramStop>, bool), ProgramStop> {
    let values = Arc::get_mut(payload).ok_or_else(coverage)?;
    if values.len() >= values.capacity() { return Err(coverage()); }
    let backing = (values.as_ptr(), values.capacity());
    let stop = try_push(values, 23).err(); // Spare capacity: no allocator callback can enforce this.
    let preserved = values.as_slice() == [17, 19] && (values.as_ptr(), values.capacity()) == backing;
    Ok((stop, preserved))
}

/// The fresh Vec has no block. Failed grow leaves its real old block untouched.
fn simulated_failure(values: &mut Vec<u64, ResourceAllocator>, allocator: &ResourceAllocator,
    report: &mut GateWitnessReport, observe: &mut impl FnMut(GateWitnessStage), old: *const u64)
    -> Result<(), ProgramStop> {
    // Arming is private fixture state, never a resource or source authority.
    allocator.arm_simulated_error(report.case == GateWitnessCase::SimulatedSourceGrow);
    let result = if report.case == GateWitnessCase::SimulatedPreStopped {
        allocator.record(super::failure(crate::resource_stop::Dimension::Work, 2, 1,
            crate::resource_stop::RefusalReason::Limit));
        allocator.enter_operation()
    } else {
        allocator.enter_operation().and_then(|()| {
            if report.case == GateWitnessCase::SimulatedFresh {
                let mut fresh = Vec::<u64, _>::new_in(allocator.clone());
                let result = fresh.try_reserve(256).map_err(|error| allocator.reserve_error(error));
                report.fresh_backing_absent = fresh.capacity() == 0 && fresh.is_empty();
                result
            } else {
                values.try_reserve(256).map_err(|error| allocator.reserve_error(error))
            }
        })
    };
    report.new_capacity = values.capacity();
    report.values_preserved = values.as_slice() == [17, 19];
    report.refused_pointer_preserved = result.is_err() && values.as_ptr() == old;
    observe(GateWitnessStage::AfterGrow);
    result
}
