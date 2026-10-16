// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `AdmissionGuard::grow_to` (#7676 review, finding 4): a cache hit on an
//! upload route is charged at least the stored entry's size, and giving it
//! back is a plain shrink.

use super::*;

const MIB: u64 = 1024 * 1024;

fn cfg(budget_mb: u64) -> AdmissionCfg {
    AdmissionCfg {
        max_concurrent_parses: 2,
        mem_budget_bytes: budget_mb * MIB,
        queue_depth: 4,
        queue_timeout: std::time::Duration::from_millis(50),
        shed_pct: 0,
    }
}

#[tokio::test]
async fn grow_to_grows_to_the_stored_size_reports_what_it_held_and_never_shrinks() {
    let a = Arc::new(Admission::new(cfg(10)));
    let mut guard = a.acquire(2 * MIB).await.expect("admit");

    assert_eq!(guard.grow_to(8 * MIB).await.unwrap(), 2 * MIB, "grew past the upload's charge");
    assert_eq!(guard.reserved(), 8 * MIB);
    assert!(a.acquire(3 * MIB).await.is_err(), "only 2 MiB of the budget is left");

    assert_eq!(guard.grow_to(MIB).await.unwrap(), 8 * MIB);
    assert_eq!(guard.reserved(), 8 * MIB, "a smaller stored entry must not shrink the upload's charge");

    guard.shrink_to(2 * MIB);
    assert!(a.acquire(8 * MIB).await.is_ok(), "shrinking back returned the bytes");
}

#[tokio::test]
async fn grow_to_waits_for_bytes_a_bounded_time_and_keeps_what_it_holds() {
    let a = Arc::new(Admission::new(cfg(10)));
    let mut guard = a.acquire(4 * MIB).await.expect("admit");
    let _other = a.acquire_resident(6 * MIB).await.expect("the rest of the budget");

    let refused = guard.grow_to(8 * MIB).await;
    assert!(matches!(refused, Err(ApiError::Overloaded { .. })), "{refused:?}");
    assert_eq!(guard.reserved(), 4 * MIB, "a refused grow must not lose the upload's charge");
}

#[tokio::test]
async fn grow_to_is_clamped_to_the_budget_and_inert_without_a_byte_gate() {
    let a = Arc::new(Admission::new(cfg(4)));
    let mut guard = a.acquire(MIB).await.expect("admit");
    guard.grow_to(100 * MIB).await.expect("a request larger than the budget runs alone");
    assert_eq!(guard.reserved(), 4 * MIB);

    let ungated = Arc::new(Admission::new(cfg(0)));
    let mut guard = ungated.acquire(MIB).await.expect("admit");
    assert_eq!(guard.grow_to(100 * MIB).await.unwrap(), 0);
    assert_eq!(guard.reserved(), 0);
}
