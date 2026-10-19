// SPDX-License-Identifier: MPL-2.0
//! Per-gate simulated boundary errors. Never substitutes a successful Global call.
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
#[derive(Default)]
pub(super) struct DelegationFixture { armed: AtomicU8, skipped: AtomicUsize, requested: AtomicUsize }
impl DelegationFixture {
    pub fn arm(&self, source_fault: bool) {
        self.armed.store(if source_fault { 2 } else { 1 }, Ordering::SeqCst);
    }
    pub fn consume(&self, requested_layout_bytes: usize) -> u8 {
        let mode = self.armed.swap(0, Ordering::SeqCst);
        if mode != 0 {
            // Actual Layout passed at the delegation boundary, never a guessed
            // Vec capacity or authority/account input. No Global call occurred.
            self.requested.store(requested_layout_bytes, Ordering::SeqCst);
            self.skipped.fetch_add(1, Ordering::SeqCst);
        }
        mode
    }
    pub fn skipped(&self) -> usize { self.skipped.load(Ordering::SeqCst) }
    pub fn requested(&self) -> usize { self.requested.load(Ordering::SeqCst) }
    pub fn armed(&self) -> bool { self.armed.load(Ordering::SeqCst) != 0 }
}

#[cfg(test)]
mod tests {
    use super::super::{fixtures::{run, clean}, failure};
    use crate::resource_stop::{Dimension, RefusalReason};
    use std::{alloc::{Allocator, Layout}, ptr::NonNull};

    #[test]
    fn simulated_grow_keeps_real_old_storage_until_free_before_refund() {
        run(1024, |decoder, work, gate, budget, _| {
            let result = gate.scope(decoder, work, |_, allocator| {
                let old = Layout::from_size_align(16, 8).unwrap();
                let new = Layout::from_size_align(40, 8).unwrap();
                let block = allocator.allocate_zeroed(old).unwrap();
                let ptr = NonNull::new(block.as_ptr().cast::<u8>()).unwrap();
                let before = budget.stats();
                allocator.arm_simulated_error(false);
                // SAFETY: exact current Global allocation and original Layout.
                assert!(unsafe { allocator.grow(ptr, old, new) }.is_err());
                let after = budget.stats();
                assert_eq!((after.live, after.observed), (16, 16));
                assert_eq!((after.allocations, after.frees, after.replacements),
                    (before.allocations, before.frees, before.replacements));
                assert_eq!(after.copies, before.copies + 16);
                assert_eq!(after.refunded, before.refunded + 40);
                assert!(!after.violation, "provisional debit is not storage to free");
                // SAFETY: failed simulated grow never called Global or moved ptr.
                assert_eq!(unsafe { ptr.as_ptr().read() }, 0);
                // SAFETY: the real old allocation still has its original Layout.
                unsafe { allocator.deallocate(ptr, old); }
                clean(budget); // Storage observer rejects refund before actual free.
                Err::<(), _>(failure(Dimension::LiveBytes, 40, 0, RefusalReason::Allocation))
            });
            assert!(result.is_err());
        });
    }
}
