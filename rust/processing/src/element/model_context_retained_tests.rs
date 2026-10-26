// SPDX-License-Identifier: MPL-2.0
//! #7955 S3: actual factory provenance, snapshot lifetime and source invalidation.
use super::*;
use ifc_lite_core::{EntityDecoder, SourceBundle};
const SOURCE: &[u8] = b"#1=IFCCARTESIANPOINT((1.,2.,3.));";

#[test]
fn s3_binding_rejects_equal_bytes_foreign_factory_and_borrowed_decoder() {
    let source = SourceBundle::new(SOURCE.to_vec());
    let model = ProductionModel::from_source(source.clone());
    let snapshot = model.snapshot(OwnedMeshProductionData::default());
    let mut genuine = source.decoder();
    assert_eq!(genuine.decode_by_id(1).unwrap().id, 1);
    assert_eq!(snapshot.validate_decoder(&genuine), Ok(()));
    let foreign = SourceBundle::new(SOURCE.to_vec());
    let mut foreign_decoder = foreign.decoder();
    assert_eq!(foreign_decoder.decode_by_id(1).unwrap().id, 1);
    assert_eq!(snapshot.validate_decoder(&foreign_decoder), Err(RetainedContextError::Mismatched));
    let borrowed = EntityDecoder::new(SOURCE);
    assert_eq!(snapshot.validate_decoder(&borrowed), Err(RetainedContextError::Mismatched));
    let unbound = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    assert_eq!(unbound.validate_decoder(&genuine), Err(RetainedContextError::Missing));
    assert_eq!(unbound.validate_source(), Ok(()), "borrowed compatibility keeps its own contract");
}

#[test]
fn s3_snapshot_and_lifecycle_cross_threads_but_expire_only_on_source_invalidation() {
    let source = SourceBundle::new(SOURCE.to_vec());
    let weak = Arc::downgrade(&source);
    let model = ProductionModel::from_source(source.clone());
    let controller = model.clone();
    let first = model.snapshot(OwnedMeshProductionData::default());
    let lifecycle = first.lifecycle();
    let second = model.snapshot(OwnedMeshProductionData::default());
    assert_ne!(lifecycle.epoch_revision(), second.lifecycle().epoch_revision());
    drop((source, model));
    std::thread::scope(|scope| scope.spawn(|| {
        let retained_source = weak.upgrade().expect("snapshots retain source allocation");
        let mut decoder = retained_source.decoder();
        assert_eq!(decoder.decode_by_id(1).unwrap().id, 1);
        assert_eq!(first.validate_decoder(&decoder), Ok(()));
        assert_eq!(lifecycle.validate(), Ok(()));
        controller.invalidate_source();
        assert_eq!(first.validate_decoder(&decoder), Err(RetainedContextError::Stale));
        assert_eq!(second.validate_decoder(&decoder), Err(RetainedContextError::Stale));
        assert_eq!(lifecycle.validate(), Err(RetainedContextError::Stale));
    }).join().unwrap());
    drop((controller, first, second));
    assert!(weak.upgrade().is_none(), "lifecycle grants no source or decoder lease");
    assert_eq!(lifecycle.validate(), Err(RetainedContextError::Stale));
}

#[path = "model_context_snapshot_only_tests.rs"]
mod snapshot_only;
