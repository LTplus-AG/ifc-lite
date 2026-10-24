// SPDX-License-Identifier: MPL-2.0
//! #7955 N1: real SDK backing admission and receipt-owned refunds.
use super::*;
use super::adversarial_tests::with_case;
use super::super::session_tests::SOURCE;
use resource::{Cost, Dimension, ExecutionAccount, ExecutionPolicy, ResourceLimits};

#[test]
fn j4_sdk_backing_refuses_header_only_budget() {
    let limit = 16 * 1024 * 1024;
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(limit), ..Default::default()
    }));
    with_case(Some(&account), SOURCE, |e, d, r, w, _, _| {
        let issued = e.issue_next(d, r, w).unwrap().unwrap();
        let headers = CommonRetainedRealization::header_bytes()
            + std::mem::size_of::<Arc<CommonRetainedRealization>>() as u64;
        let _held = account.charge(Cost { live_bytes: limit - account.usage().live_bytes - headers,
            ..Default::default() }).unwrap();
        let result = issued.execute(w, 0.001, 15., MeshLimits::default());
        let rejected = result.err().expect("N1_BACKING_ADMISSION: headers alone must not admit SDK buffers");
        assert!(matches!(rejected.reason, RetainedExecutionError::Stopped(
            ProgramStop::ResourceRefused(resource::ResourceFailure { dimension: Dimension::LiveBytes, .. })
        )), "N1_BACKING_ADMISSION: report original live-byte refusal");
        assert_eq!(e.discharged_count(), 0);
        assert!(w.retained_owner().incarnation().is_none());
    });
}

#[test]
fn j4_sdk_backing_follows_last_receipt_and_refunds_live_only() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(Default::default()));
    let mut retained = None;
    let mut backing = 0;
    with_case(Some(&account), SOURCE, |e, d, r, w, _, _| {
        let issued = e.issue_next(d, r, w).unwrap().unwrap();
        let before = account.usage();
        let completed = issued.execute(w, 0.001, 15., MeshLimits::default()).unwrap();
        let receipt = completed.realizations()[0].clone();
        let mesh = &receipt.construction().unwrap().completion().tessellation;
        backing = (mesh.positions.len() * 8 + mesh.indices.len() * 4
            + mesh.flat_corner_normals.len() * 8 + mesh.revision_local_faces.len() * 4) as u64;
        assert!(backing > 0, "SDK must return real tessellation");
        assert_eq!(account.usage().copy_bytes - before.copy_bytes, backing,
            "N1_BACKING_COPY: charge actual transferred backing cumulatively");
        assert!(account.usage().live_bytes >= before.live_bytes + backing + CommonRetainedRealization::header_bytes(),
            "N1_BACKING_LIFETIME: completed receipt owns backing charge");
        e.accept(completed, d, r).unwrap_or_else(|error| panic!("{}", error.reason));
        retained = Some(receipt);
    });
    if retained.is_none() { return; } // with_case reports absent SDK; parent rejects skips.
    let before_drop = account.usage();
    drop(retained);
    assert_eq!(before_drop.live_bytes - account.usage().live_bytes,
        backing + CommonRetainedRealization::header_bytes(),
        "N1_BACKING_REFUND: last receipt releases backing and header exactly once");
    assert_eq!(account.usage().copy_bytes, before_drop.copy_bytes,
        "N1_BACKING_REFUND: cumulative copies never refund");
}
