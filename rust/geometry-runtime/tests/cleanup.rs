// SPDX-License-Identifier: MPL-2.0
//! Runtime review finding 3: cleanup failure must retire despite primary error.
#![cfg(all(unix, not(target_arch = "wasm32")))]
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker, WorkerError};
use std::sync::atomic::{AtomicU64, Ordering};

#[test]
fn failed_mesh_release_retires_on_read_success_and_preserves_primary_limit_error() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for oversized in [false, true] {
        let directory = std::env::temp_dir().join(format!(
            "ifclite-mesh-cleanup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("peer");
        std::os::unix::fs::symlink(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/mesh-release-peer.py"),
            &executable,
        )
        .unwrap();
        if oversized {
            std::fs::write(directory.join("oversize"), b"oversized").unwrap();
        }
        let mut worker = SmlibWorker::spawn(&executable).unwrap();
        let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
        let pid = worker.process_id();
        // The oversized peer advertises a mesh beyond any limit; the other peer
        // returns a tiny valid mesh whose mesh handle cannot then be released.
        let max_bytes = if oversized { 0 } else { 1 << 20 };
        let result = worker.tessellate(solid, 0.001, 15., MeshLimits { max_bytes });
        if oversized {
            assert!(matches!(
                result,
                Err(WorkerError::ResourceLimit("mesh exceeds max_bytes"))
            ));
        } else {
            assert!(matches!(result, Err(WorkerError::Kernel { .. })));
        }
        assert_eq!(worker.incarnation(), 0);
        #[cfg(target_os = "linux")]
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "retirement must reap"
        );
        assert!(matches!(
            worker.create_box([0.; 3], [1.; 3]),
            Err(WorkerError::Protocol(_))
        ));
        drop(worker);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn primary_limit_failure_never_caches_worker_retired_by_mesh_cleanup() {
    use ifc_lite_geometry_runtime::{
        SupervisedWorker, SupervisionError, WorkerCommand, WorkerResult,
    };
    use std::time::Duration;
    let directory =
        std::env::temp_dir().join(format!("ifclite-retired-cache-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let executable = directory.join("peer");
    std::os::unix::fs::symlink(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/mesh-release-peer.py"),
        &executable,
    )
    .unwrap();
    std::fs::write(directory.join("oversize"), b"oversized").unwrap();
    let worker = SupervisedWorker::new(executable.into_os_string(), 0).unwrap();
    let run = |command| {
        worker
            .submit(command, Duration::from_secs(30))
            .unwrap()
            .wait()
    };
    let WorkerResult::Incarnation(old) = run(WorkerCommand::Incarnation).unwrap() else {
        panic!("identity")
    };
    let WorkerResult::Solid(solid) = run(WorkerCommand::CreateBox {
        origin: [0.; 3],
        size: [2.; 3],
    })
    .unwrap() else {
        panic!("transport handle")
    };
    let pid = worker.process_id().unwrap();
    assert!(matches!(
        run(WorkerCommand::Tessellate {
            solid,
            chord_metres: 0.001,
            angle_degrees: 15.,
            limits: MeshLimits { max_bytes: 0 }
        }),
        Err(SupervisionError::Worker(WorkerError::ResourceLimit(
            "mesh exceeds max_bytes"
        )))
    ));
    assert_eq!(worker.process_id(), None);
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    // Must succeed directly; no sacrificial failing request on a cached dead client.
    let WorkerResult::Incarnation(fresh) = run(WorkerCommand::Incarnation).unwrap() else {
        panic!("identity")
    };
    assert_ne!(fresh, 0);
    assert_ne!(fresh, old);
    if std::env::var_os("IFCLITE_SMLIB_WORKER").is_some() {
        // On restart this immutable peer execs the actual SDK in the same Child.
        let WorkerResult::Solid(real) = run(WorkerCommand::CreateBox {
            origin: [0.; 3],
            size: [2.; 3],
        })
        .unwrap() else {
            panic!("actual SDK box")
        };
        let WorkerResult::Volume(volume) = run(WorkerCommand::Volume {
            solid: real,
            relative_accuracy: 1e-8,
        })
        .unwrap() else {
            panic!("actual volume")
        };
        assert!((volume - 8.).abs() < 1e-6);
        run(WorkerCommand::Release { solid: real }).unwrap();
    } else {
        eprintln!("SKIP actual SDK next-session geometry: IFCLITE_SMLIB_WORKER absent; protocol cache invariant exercised");
    }
    drop(worker);
    std::fs::remove_dir_all(directory).unwrap();
}
