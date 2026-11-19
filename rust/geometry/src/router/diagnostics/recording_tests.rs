// SPDX-License-Identifier: MPL-2.0

use super::*;
use crate::diagnostics::{BoolFailureReason, BoolOp};

#[test]
fn map_only_drain_preserves_successful_rectangular_measurements_10510() {
    let router = GeometryRouter::new();
    let failure = BoolFailure::new(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid);
    let bounds = ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0));
    for host in 1..=3 {
        router.record_host_cut_effect(host, 12, 12, 1, bounds);
        if host == 2 {
            router.record_host_failure_summary(host, std::slice::from_ref(&failure));
        }
        router.record_rectangular_cut_measure(host, true);
    }

    assert_eq!(router.take_host_opening_diagnostics().len(), 3);
    router.record_host_failure_summary(3, &[failure]);

    let (diagnostics, unchanged) = router.take_host_opening_report();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[&3].csg_failure_count, 1);
    assert_eq!(unchanged, 1, "only the successful cut should survive both drains");
    assert_eq!(router.take_host_opening_report().1, 0, "measurements drain once");
}
