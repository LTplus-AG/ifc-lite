// SPDX-License-Identifier: MPL-2.0
//! #7955 R5-SCAN-LIVE-LIFETIME: actual removal proofs, not fabricated state.
use super::*;
use super::terminal_tests::complete;
fn account() -> resource::ExecutionAccount {
    resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits {
        work: Some(100_000_000), live_bytes: Some(1_000_000), ..Default::default()
    }))
}
#[test]
fn j2_terminal_scan_refunds_live_bytes_but_keeps_work() {
    let Some(mut worker) = super::tests::worker() else { return };
    for reject in [false,true] {
        let mut source = super::opening_witness::removal_sources().remove(0);
        if reject { source = source.replace("ENDSEC;\nEND-ISO-10303-21;",
            "#900=IFCMATERIALLAYER($,-1.,$,$,$,$,$);\nENDSEC;END-ISO-10303-21;"); }
        let account = account();
        account.scope(|| super::opening_tests::with_source(&source,|execution,decoder,router| {
            complete(execution,decoder,router,&mut worker);
            assert!(execution.has_authenticated_opening_removal());
            // Repeating only the private predicate is intentional. Never retry
            // the public terminal transaction. No persistent scan state exists.
            for _ in 0..2 {
                let before = account.usage();
                let result = super::terminal_policy::validate(execution);
                if reject { assert!(matches!(result,Err(RetainedExecutionError::Unsupported(_)))); }
                else { result.unwrap(); }
                let after = account.usage();
                assert_eq!(after.live_bytes,before.live_bytes,"J2_SCAN_LIVE_REFUND");
                assert_eq!(after.work-before.work,source.len() as u64,"J2_SCAN_WORK_CUMULATIVE");
                assert!(!router.host_consumed_by_void(30));
            }
        }));
    }
}
#[test]
fn j2_terminal_sequential_removals_share_scan_headroom() {
    let Some(mut worker) = super::tests::worker() else { return };
    let source = super::opening_witness::removal_sources().remove(0);
    let account = account();
    account.scope(|| {
        for _ in 0..2 {
            // Both real controllers use the SAME account. All controller,
            // router and output storage from this iteration dies before next.
            super::opening_tests::with_source(&source,|execution,decoder,router| {
                complete(execution,decoder,router,&mut worker);
                let before = account.usage();
                let scan = source.len() as u64 * 8;
                // Reserve unrelated live storage, leaving one scanner plus a
                // small terminal allowance, strictly less than two scanners.
                let allowance = source.len() as u64;
                let ballast = execution.resources.charge(resource::Cost {
                    live_bytes: 1_000_000-before.live_bytes-scan-allowance,..Default::default()
                }).unwrap();
                let admitted = account.usage();
                let result = execution.publish_removed(decoder,router,&worker).expect("J2_SCAN_SEQUENTIAL");
                assert!(router.host_consumed_by_void(30));
                assert!(account.usage().live_bytes < admitted.live_bytes+allowance,"J2_SCAN_SEQUENTIAL_REFUND");
                assert!(account.usage().work >= before.work+source.len() as u64);
                let output = result.into_output();
                assert!(output.meshes.is_empty() && output.instance_occurrences.is_empty());
                drop(output);
                drop(ballast);
            });
            account.check().expect("J2_SCAN_SHARED_ACCOUNT_LIVE");
        }
    });
}
