// SPDX-License-Identifier: MPL-2.0
//! P2 malformed metadata refuses and retires; a fault peer is no SDK proof.
#![cfg(all(unix, not(target_arch = "wasm32")))]
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker, WorkerError};

#[test]
fn mismatched_empty_certificate_or_partial_mesh_retires_native_worker() {
    for (case, (query, info)) in [
        (0, [0,0,0,0,0,0]), (1, [1,0,0,0,0,0]), (1, [0,1,0,0,0,0]),
        (1, [0,0,1,0,0,0]), (1, [0,0,0,1,0,0]), (1, [0,0,0,0,1,0]),
        (1, [0,0,0,0,0,1]), (0, [1,1,1,0,0,1]), (2, [0,0,0,0,0,0]),
    ].into_iter().enumerate() {
        let directory = std::env::temp_dir().join(format!("ifclite-empty-metadata-{}-{case}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let peer = directory.join("peer");
        std::os::unix::fs::symlink(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/empty-metadata-peer.py"), &peer).unwrap();
        std::fs::write(directory.join("metadata.json"),
            format!(r#"{{"query":{query},"info":{info:?}}}"#)).unwrap();
        let mut worker = SmlibWorker::spawn(&peer).unwrap();
        let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
        assert!(matches!(worker.tessellate(solid, 0.001, 5., MeshLimits::default()), Err(WorkerError::Protocol(_))));
        assert_eq!(worker.incarnation(), 0);
        drop(worker);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
