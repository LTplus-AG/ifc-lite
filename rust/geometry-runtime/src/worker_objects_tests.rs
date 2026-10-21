// SPDX-License-Identifier: MPL-2.0
//! Private lease/queue states. Protocol peers witness lifetime only, never
//! numerical geometry; public receipt lifetimes are in tests/object_lifetime.rs.
use super::*;

fn peer() -> SmlibWorker {
    SmlibWorker::spawn(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/object-release-peer.py"),
    )
    .unwrap()
}

#[test]
fn final_shared_lease_queues_one_object_released_by_the_next_command() {
    let mut worker = peer();
    let incarnation = worker.incarnation();
    let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
    // Repeated management of one object is one shared final owner.
    let first = worker.manage_object(solid).unwrap();
    let second = worker.manage_object(solid).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    drop(first);
    assert!(worker.object_liveness(solid).is_ok());
    drop(second);
    assert!(worker.object_liveness(solid).is_err());
    assert_eq!(worker.releases.pending.lock().unwrap().as_slice(), &[solid]);
    // The next command releases it first; the process and session survive.
    worker.create_box([0.; 3], [1.; 3]).unwrap();
    assert!(worker.releases.pending.lock().unwrap().is_empty());
    assert!(!worker.objects.contains_key(&solid.wire));
    assert_eq!(worker.incarnation(), incarnation);
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
