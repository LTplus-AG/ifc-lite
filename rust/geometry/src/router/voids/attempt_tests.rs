// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Speculative host attempts own their diagnostics: a rejected or unwound
//! attempt restores the pre-attempt state of that host only.

use super::{AttemptGuard, HostSnapshot};
use crate::router::GeometryRouter;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn failure(host: u32) -> crate::BoolFailure {
    crate::BoolFailure::new(
        crate::diagnostics::BoolOp::Difference,
        crate::diagnostics::BoolFailureReason::OperandTooLarge {
            polys_a: 1,
            polys_b: 1,
        },
    )
    .with_product_id(host)
}

fn record(router: &GeometryRouter, host: u32) {
    router.record_csg_failures(host, vec![failure(host)]);
    router.record_void_consumed_host(host);
}

#[test]
fn rejected_attempt_restores_only_its_host() {
    let router = GeometryRouter::new();
    record(&router, 1);
    {
        let _attempt = AttemptGuard::new(&router, 2);
        record(&router, 2);
        router.record_csg_failures(1, vec![failure(1)]);
    }
    assert!(!router.host_consumed_by_void(2));
    assert!(router.host_consumed_by_void(1));
    let failures = router.take_csg_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(
        failures[&1].len(),
        2,
        "another host's record is not this attempt's to undo"
    );
}

#[test]
fn accepted_attempt_keeps_everything_once() {
    let router = GeometryRouter::new();
    let attempt = AttemptGuard::new(&router, 7);
    record(&router, 7);
    attempt.accept();
    assert!(router.host_consumed_by_void(7));
    let failures = router.take_csg_failures();
    assert_eq!(failures[&7].len(), 1);
    assert!(router.take_csg_failures().is_empty());
}

#[test]
fn unwound_attempt_restores_and_preserves_the_original_payload() {
    let router = GeometryRouter::new();
    record(&router, 3);
    let payload = catch_unwind(AssertUnwindSafe(|| {
        let _attempt = AttemptGuard::new(&router, 3);
        router.record_csg_failures(3, vec![failure(3)]);
        std::panic::panic_any(41_u32);
    }))
    .expect_err("the panic must propagate");
    assert_eq!(payload.downcast_ref::<u32>(), Some(&41));
    assert_eq!(router.take_csg_failures()[&3].len(), 1);
}

#[test]
fn snapshot_restore_round_trips_absent_state() {
    let router = GeometryRouter::new();
    let snapshot = HostSnapshot::capture(&router, 9);
    record(&router, 9);
    snapshot.restore(&router);
    assert!(!router.host_consumed_by_void(9));
    assert!(router.take_csg_failures().is_empty());
}
