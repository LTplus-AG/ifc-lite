// SPDX-License-Identifier: MPL-2.0
//! #7955 S3: refuse annotation storage before creating the owner.

#[test]
fn s3_outcome_allocation_refuses_before_creating_an_annotation() {
    // Real accounting invariant: allocation is charged before Arc creation.
    let account = crate::resource::ExecutionAccount::new(crate::resource::ExecutionPolicy::Bounded(
        crate::resource::ResourceLimits { live_bytes: Some(0), ..Default::default() }));
    account.scope(|| {
        let error = super::new().unwrap_err();
        assert!(matches!(error, crate::Error::ProgramStopped(crate::resource::ProgramStop::ResourceRefused(failure))
            if failure.dimension == crate::resource::Dimension::LiveBytes && failure.requested > 0));
        assert_eq!(account.usage().live_bytes, 0);
    });
}
