// SPDX-License-Identifier: MPL-2.0
/// Process-unique program identity without a shared atomic per item: each
/// thread reserves a block of identities and hands them out locally.
pub(super) fn next_program_id() -> u64 {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    const BLOCK: u64 = 1 << 20;
    static NEXT_BLOCK: AtomicU64 = AtomicU64::new(1);
    thread_local! {
        static RANGE: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
    }
    RANGE
        .try_with(|range| {
            let (mut next, mut end) = range.get();
            if next == end {
                next = NEXT_BLOCK.fetch_add(BLOCK, Ordering::Relaxed);
                end = next.wrapping_add(BLOCK);
            }
            range.set((next.wrapping_add(1), end));
            next
        })
        // Thread teardown: fall back to one identity from a fresh shared block.
        .unwrap_or_else(|_| NEXT_BLOCK.fetch_add(BLOCK, Ordering::Relaxed))
}
