// SPDX-License-Identifier: MPL-2.0
//! Protocol peers witness lifetime only, never numerical geometry.
use super::*;

fn peer() -> SmlibWorker {
    SmlibWorker::spawn(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/object-release-peer.py"),
    )
    .unwrap()
}

#[test]
fn final_shared_lease_invalidates_before_deferred_release_failure() {
    // Production lifetime seam: repeated private management is one final owner.
    let mut worker = peer();
    let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
    let first = worker.manage_object(solid).unwrap();
    let second = worker.manage_object(solid).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    drop(first);
    assert!(worker.object_liveness(solid).is_ok());
    drop(second);
    assert!(worker.object_liveness(solid).is_err());
    assert_eq!(worker.releases.pending.lock().unwrap().len(), 1);
    assert!(matches!(
        worker.create_box([0.; 3], [1.; 3]),
        Err(WorkerError::Kernel { .. })
    ));
    assert_eq!(worker.incarnation(), 0);
    assert!(matches!(
        worker.create_box([0.; 3], [1.; 3]),
        Err(WorkerError::Protocol(_))
    ));
}

#[test]
fn explicit_release_of_queued_object_reports_cleanup_failure() {
    let mut worker = peer();
    let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
    drop(worker.manage_object(solid).unwrap());
    assert!(matches!(
        worker.release(solid),
        Err(WorkerError::Kernel { .. })
    ));
    assert_eq!(worker.incarnation(), 0);
}

#[test]
fn queue_capacity_and_poison_retire_captured_owner() {
    for poison in [false, true] {
        let mut worker = peer();
        let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
        let lease = worker.manage_object(solid).unwrap();
        if poison {
            let queue = worker.releases.clone();
            assert!(std::thread::spawn(move || {
                let _lock = queue.pending.lock().unwrap();
                panic!("intentional queue poison");
            })
            .join()
            .is_err());
        } else {
            worker
                .releases
                .pending
                .lock()
                .unwrap()
                .resize(MAX_PENDING_RELEASES, solid);
        }
        drop(lease);
        assert_eq!(worker.incarnation(), 0);
    }
}

#[test]
fn stale_lease_after_worker_exit_cannot_retire_replacement() {
    let mut old = peer();
    let solid = old.create_box([0.; 3], [1.; 3]).unwrap();
    let lease = old.manage_object(solid).unwrap();
    old.terminate().unwrap();
    drop(old);
    let mut replacement = peer();
    let incarnation = replacement.incarnation();
    drop(lease);
    assert_eq!(replacement.incarnation(), incarnation);
    replacement.create_box([0.; 3], [1.; 3]).unwrap();
}

#[test]
fn foreign_release_cannot_dispatch_queued_cleanup_or_retire_local_owner() {
    // Review of b20f191: a foreign release must not flush this worker's queue.
    let mut a = peer();
    let mut b = peer();
    let local = a.create_box([0.; 3], [1.; 3]).unwrap();
    let foreign = b.create_box([0.; 3], [1.; 3]).unwrap();
    drop(a.manage_object(local).unwrap());
    let incarnation = a.incarnation();
    let mut foreign_session = local;
    foreign_session.wire.session += 1;
    let mut unknown_generation = local;
    unknown_generation.wire.generation += 1;
    let mut unknown_slot = local;
    unknown_slot.wire.slot += 1;
    for rejected in [foreign, foreign_session, unknown_generation, unknown_slot] {
        assert!(matches!(a.release(rejected), Err(WorkerError::WrongWorker)));
        assert_eq!(a.incarnation(), incarnation);
        assert_eq!(a.releases.pending.lock().unwrap().as_slice(), &[local]);
    }
    assert!(matches!(
        a.flush_releases(),
        Err(WorkerError::Kernel { .. })
    ));
    assert_eq!(a.incarnation(), 0);
    assert_ne!(b.incarnation(), 0);
}
