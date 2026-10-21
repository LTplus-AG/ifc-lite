// SPDX-License-Identifier: MPL-2.0
//! Managed receipt lifetime through the public API, against a protocol peer
//! whose committed sweep solids fail to release. Lifetime evidence only; the
//! numerical witnesses are in managed_objects.rs.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion};
use ifc_lite_geometry_runtime::{MeshLimits, RetainedRealization, SmlibWorker, WorkerError};

#[cfg(unix)]
fn peer() -> SmlibWorker {
    SmlibWorker::spawn(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/object-release-peer.py"),
    )
    .unwrap()
}

/// A rectangle needs no curved witness, so the peer can serve it.
#[cfg(unix)]
fn receipt(worker: &mut SmlibWorker) -> RetainedRealization {
    let data = "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);\
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);#5=IFCDIRECTION((0.,0.,1.));\
#6=IFCEXTRUDEDAREASOLID(#4,$,#5,3.);";
    let mut decoder =
        EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let entity = decoder.decode_by_id(6).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion {
            source,
            length_unit_scale: 1.,
        })
        .unwrap();
    let request = document
        .prepare_retained(definition, worker.incarnation())
        .unwrap();
    worker
        .evaluate_retained(request, 0.001, 15., MeshLimits::default())
        .unwrap()
}

#[cfg(unix)]
#[test]
fn dropped_receipt_invalidates_only_its_object_and_reports_deferred_failure() {
    let mut worker = peer();
    let incarnation = worker.incarnation();
    let sibling = worker.create_box([0.; 3], [1.; 3]).unwrap();
    let receipt = receipt(&mut worker);
    let solid = receipt.solid();
    drop(receipt);
    // Invalid at once, refused locally, and the process is untouched.
    assert!(matches!(
        worker.volume(solid, 1e-8),
        Err(WorkerError::WrongWorker)
    ));
    assert_eq!(worker.incarnation(), incarnation);
    // The next command first releases the queued object; its failure retires
    // this exact process and is reported instead of running the command.
    assert!(matches!(
        worker.volume(sibling, 1e-8),
        Err(WorkerError::Kernel { .. })
    ));
    assert_eq!(worker.incarnation(), 0);
    assert!(matches!(
        worker.create_box([0.; 3], [1.; 3]),
        Err(WorkerError::Protocol(_))
    ));
}

#[cfg(unix)]
#[test]
fn explicit_release_of_a_dropped_receipt_reports_its_cleanup_failure() {
    let mut worker = peer();
    let receipt = receipt(&mut worker);
    let solid = receipt.solid();
    drop(receipt);
    assert!(matches!(
        worker.release(solid),
        Err(WorkerError::Kernel { .. })
    ));
    assert_eq!(worker.incarnation(), 0);
}

#[cfg(unix)]
#[test]
fn consumed_raw_escape_disarms_managed_cleanup() {
    let mut worker = peer();
    let incarnation = worker.incarnation();
    let (raw, _) = receipt(&mut worker).into_host_trusted_parts();
    // Nothing is queued: commands succeed and the raw handle stays live.
    worker.flush_releases().unwrap();
    assert_eq!(worker.volume(raw, 1e-8).unwrap(), 1.);
    assert_eq!(worker.incarnation(), incarnation);
}

#[cfg(unix)]
#[test]
fn stale_receipt_after_worker_exit_cannot_retire_replacement() {
    let mut old = peer();
    let receipt = receipt(&mut old);
    old.terminate().unwrap();
    drop(old);
    let mut replacement = peer();
    let incarnation = replacement.incarnation();
    drop(receipt);
    assert_eq!(replacement.incarnation(), incarnation);
    replacement.create_box([0.; 3], [1.; 3]).unwrap();
}

#[cfg(unix)]
#[test]
fn foreign_or_stale_release_never_drains_this_workers_queue() {
    let mut a = peer();
    let mut b = peer();
    let stale = a.create_box([0.; 3], [1.; 3]).unwrap();
    a.release(stale).unwrap();
    // Same wire session and slot numbers, different worker.
    let foreign = b.create_box([0.; 3], [1.; 3]).unwrap();
    drop(receipt(&mut a));
    let incarnation = a.incarnation();
    for rejected in [foreign, stale] {
        assert!(matches!(a.release(rejected), Err(WorkerError::WrongWorker)));
        assert_eq!(a.incarnation(), incarnation);
    }
    // The queued failure is still pending for this worker alone.
    assert!(matches!(
        a.flush_releases(),
        Err(WorkerError::Kernel { .. })
    ));
    assert_eq!(a.incarnation(), 0);
    assert_ne!(b.incarnation(), 0);
}
