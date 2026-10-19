// SPDX-License-Identifier: MPL-2.0
//! R4 requested-Layout and fallible container invariants with real Global storage.
use super::{backend::Backend, containers::*, fixtures::*, failure};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use std::{alloc::{Allocator, Layout}, ptr::NonNull};

#[test]
fn r4_layout_debit_precedes_storage_and_refund_follows_free() {
    run(1024, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let layout = Layout::from_size_align(37, 8).unwrap();
            let block = allocator.allocate_zeroed(layout).unwrap();
            assert_eq!((budget.stats().live, budget.stats().observed), (37, 37));
            // SAFETY: allocated block has layout.size initialized zero bytes.
            assert!(unsafe { block.as_ref() }.iter().all(|byte| *byte == 0));
            let ptr = NonNull::new(block.as_ptr().cast::<u8>()).unwrap();
            // SAFETY: unchanged live block and exact original Layout.
            unsafe { allocator.deallocate(ptr, layout); }
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn r4_grow_shrink_and_zeroed_grow_account_full_overlap() {
    run(1024, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let old = Layout::from_size_align(16, 8).unwrap();
            let larger = Layout::from_size_align(48, 8).unwrap();
            let small = Layout::from_size_align(8, 8).unwrap();
            let block = allocator.allocate_zeroed(old).unwrap();
            let ptr = NonNull::new(block.as_ptr().cast::<u8>()).unwrap();
            // SAFETY: each resize uses the current live block and fitting Layout.
            let block = unsafe { allocator.grow_zeroed(ptr, old, larger) }.unwrap();
            assert_eq!(budget.stats().peak, 64);
            assert_eq!((budget.stats().live, budget.stats().observed), (48, 48));
            // SAFETY: grow_zeroed initialized the whole original-zero block.
            assert!(unsafe { block.as_ref() }.iter().all(|byte| *byte == 0));
            let ptr = NonNull::new(block.as_ptr().cast::<u8>()).unwrap();
            // SAFETY: pointer/layout describe the current grown allocation.
            let block = unsafe { allocator.shrink(ptr, larger, small) }.unwrap();
            assert_eq!((budget.stats().live, budget.stats().observed), (8, 8));
            let ptr = NonNull::new(block.as_ptr().cast::<u8>()).unwrap();
            // SAFETY: pointer/layout describe the current shrunk allocation.
            unsafe { allocator.deallocate(ptr, small); }
            assert_eq!(budget.stats().copies, 24);
            assert_eq!(budget.stats().replacements, 2);
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn r4_refused_grow_keeps_old_pointer_and_cumulative_copy_cost() {
    run(48, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let old = Layout::from_size_align(16, 8).unwrap();
            let new = Layout::from_size_align(40, 8).unwrap();
            let block = allocator.allocate_zeroed(old).unwrap();
            let ptr = NonNull::new(block.as_ptr().cast::<u8>()).unwrap();
            // SAFETY: live original block; failure must preserve it.
            assert!(unsafe { allocator.grow(ptr, old, new) }.is_err());
            let expected = failure(Dimension::LiveBytes, 40, 32, RefusalReason::Limit);
            assert_eq!(allocator.error(), expected);
            assert_eq!(budget.stats().copies, 16);
            assert_eq!((budget.stats().live, budget.stats().observed), (16, 16));
            // SAFETY: failed grow left this exact block valid.
            assert_eq!(unsafe { ptr.as_ptr().read() }, 0);
            // SAFETY: cleanup is valid after terminal refusal, without work admission.
            unsafe { allocator.deallocate(ptr, old); }
            clean(budget);
            Err::<(), _>(expected)
        });
        assert_eq!(result, budget.stats().terminal.map_or(Ok(()), Err));
    });
}

#[test]
fn r4_box_overflow_is_classified_before_allocator_and_preserves_original_stop() {
    run(u64::MAX, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let before = budget.stats().allocations;
            let result = try_box_slice::<u64>(allocator, usize::MAX, |_| unreachable!());
            assert!(matches!(result, Err(ProgramStop::ResourceRefused(failure))
                if failure.reason == RefusalReason::Overflow));
            assert_eq!(budget.stats().allocations, before);
            result.map(|_| ())
        });
        assert!(result.is_err());
        clean(budget);
    });
    run(u64::MAX, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            budget.stop(ProgramStop::Cancelled);
            let result = try_box_slice::<u64>(allocator, usize::MAX, |_| unreachable!());
            assert!(matches!(result, Err(ProgramStop::Cancelled)));
            assert_eq!(budget.stats().allocations, 0);
            result.map(|_| ())
        });
        assert_eq!(result, Err(ProgramStop::Cancelled));
    });
}

#[test]
fn r4_partial_box_prefix_drops_nested_allocations_on_failure_and_unwind() {
    for panic in [false, true] {
        run(4096, |decoder, work, gate, budget, _| {
            let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                gate.scope(decoder, work, |_, allocator| {
                    try_box_slice(allocator, 4, |index| {
                        if index == 2 {
                            if panic { panic!("intentional slice initialization unwind"); }
                            return Err(ProgramStop::Cancelled);
                        }
                        let mut nested = Vec::new_in(allocator.clone());
                        try_push(&mut nested, index as u64)?;
                        Ok(nested)
                    }).map(|_| ())
                })
            }));
            if panic { assert!(unwind.is_err()); }
            else { assert_eq!(unwind.unwrap(), Err(ProgramStop::Cancelled)); }
            assert_eq!(budget.stats().allocations, budget.stats().frees);
            clean(budget);
        });
    }
}

#[test]
fn r4_successful_box_and_zero_sized_storage_keep_real_destructors() {
    run(4096, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let values = try_box_slice(allocator, 3, |index| Ok(index as u64))?;
            assert_eq!(values.as_ref(), &[0, 1, 2]);
            drop(values);
            let before = budget.stats().allocations;
            let empty = try_box_slice::<u64>(allocator, 0, |_| unreachable!())?;
            let zst = try_box_slice(allocator, 5, |_| Ok(()))?;
            assert_eq!((empty.len(), zst.len()), (0, 5));
            drop((empty, zst));
            assert_eq!(budget.stats().allocations, before);
            let layout = Layout::from_size_align(0, 8).unwrap();
            let block = allocator.allocate(layout).unwrap();
            let ptr = NonNull::new(block.as_ptr().cast::<u8>()).unwrap();
            // SAFETY: zero-sized Global block with the exact fitting Layout.
            unsafe { allocator.deallocate(ptr, layout); }
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn r4_zero_budget_and_vec_capacity_overflow_never_reach_global() {
    run(0, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| try_arc(allocator, 1u64).map(drop));
        assert!(matches!(result, Err(ProgramStop::ResourceRefused(failure))
            if failure.dimension == Dimension::LiveBytes && failure.reason == RefusalReason::Limit));
        assert_eq!(budget.stats().allocations, 0);
        assert!(budget.stats().work > 0, "attempted operation work is cumulative");
        clean(budget);
    });
    run(u64::MAX, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            allocator.enter_operation()?;
            let mut values = Vec::<u64, _>::new_in(allocator.clone());
            let failure = allocator.reserve_error(values.try_reserve(usize::MAX).unwrap_err());
            assert!(matches!(failure, ProgramStop::ResourceRefused(f)
                if f.reason == RefusalReason::Overflow));
            assert_eq!(budget.stats().allocations, 0);
            Err::<(), _>(failure)
        });
        assert!(result.is_err());
        clean(budget);
    });
}
