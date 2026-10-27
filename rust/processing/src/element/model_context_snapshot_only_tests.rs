// SPDX-License-Identifier: MPL-2.0
//! #7955 S3 Q1: snapshot ownership without a surviving model controller.
use super::*;
use ifc_lite_core::{execution_owner::ExecutionLeaseError, IfcType};

#[test]
fn s3_snapshot_alone_retains_source_for_cross_thread_decode_then_releases_it() {
    let source = SourceBundle::new(SOURCE.to_vec());
    let weak = Arc::downgrade(&source);
    let model = ProductionModel::from_source(source.clone());
    let controller = model.clone();
    let snapshot = model.snapshot(OwnedMeshProductionData::default());
    let lifecycle = snapshot.lifecycle();
    let epoch_revision = lifecycle.epoch_revision();

    // Drop EVERY model handle and the original source before any upgrade or
    // decoder exists. The actual snapshot is now the only source owner.
    drop((controller, model, source));
    let worker_weak = weak.clone();
    let snapshot = std::thread::spawn(move || {
        assert_eq!(
            worker_weak.strong_count(),
            1,
            "S3_SNAPSHOT_ONLY_RETENTION: snapshot alone must retain the source"
        );
        let retained_source = worker_weak.upgrade().expect("snapshot-owned source");
        let mut decoder = retained_source.decoder();
        let point = decoder.decode_by_id(1).unwrap();
        assert_eq!(point.id, 1);
        assert_eq!(point.ifc_type, IfcType::IfcCartesianPoint);
        assert_eq!(decoder.get_raw_bytes(1).unwrap(), SOURCE);
        assert_eq!(snapshot.validate_decoder(&decoder), Ok(()));

        // Source/lifecycle ownership does not keep a dropped decoder's
        // execution authority alive, even while the snapshot still exists.
        let lease = decoder.try_execution_lease().unwrap();
        let identity = decoder.execution_identity();
        assert_eq!(lease.validate(identity), Ok(()));
        drop(point);
        drop(decoder);
        assert_eq!(lease.validate(identity), Err(ExecutionLeaseError::OwnerDropped));
        drop((lease, retained_source));
        assert_eq!(worker_weak.strong_count(), 1, "decoder and upgrade released");
        snapshot
    }).join().unwrap();

    assert_eq!(lifecycle.validate(), Ok(()));
    assert_eq!(weak.strong_count(), 1);
    drop(snapshot);
    assert!(weak.upgrade().is_none(), "lifecycle alone retains no source allocation");
    // ModelState legitimately outlives the source. With no explicit source
    // invalidation, its valid epoch is neither source nor decoder authority.
    assert_eq!(lifecycle.validate(), Ok(()));
    assert_eq!(lifecycle.epoch_revision(), epoch_revision);
}
