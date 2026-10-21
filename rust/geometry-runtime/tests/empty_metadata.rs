// SPDX-License-Identifier: MPL-2.0
//! Malformed or uncertified empty metadata refuses and retires the process.
//! A fault peer is never SDK evidence; `sealed_empty.rs` is the actual proof.
#![cfg(all(unix, not(target_arch = "wasm32")))]
use ifc_lite_geometry_runtime::{MeshLimits, NumericalOutcome, SmlibWorker, WorkerError};
use std::path::Path;

/// One peer per scenario: adapter capability bits, its opcode 19 answer and
/// the six mesh-info counts it reports for the solid's strict tessellation.
fn tessellate(case: usize, capabilities: u32, query: u32, info: [u32; 6]) -> SmlibWorker {
    let directory = std::env::temp_dir().join(format!(
        "ifclite-empty-metadata-{}-{case}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir(&directory).unwrap();
    let peer = directory.join("peer");
    std::os::unix::fs::symlink(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/empty-metadata-peer.py"),
        &peer,
    )
    .unwrap();
    std::fs::write(
        directory.join("metadata.json"),
        format!(r#"{{"capabilities":{capabilities},"query":{query},"info":{info:?}}}"#),
    )
    .unwrap();
    let mut worker = SmlibWorker::spawn(&peer).unwrap();
    let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
    let result = worker.tessellate(solid, 0.001, 5., MeshLimits::default());
    if worker.incarnation() == 0 {
        assert!(
            matches!(result, Err(WorkerError::Protocol(_))),
            "{case}: {result:?}"
        );
    } else {
        let mesh = result.unwrap();
        assert_eq!(mesh.outcome(), NumericalOutcome::Empty, "{case}");
        assert!(mesh.positions.is_empty() && mesh.indices.is_empty());
        assert!(mesh.corner_normals.is_empty() && mesh.source_faces.is_empty());
    }
    std::fs::remove_dir_all(directory).unwrap();
    worker
}

#[test]
fn uncertified_or_partial_empty_metadata_retires_native_worker() {
    let zero = [0; 6];
    for (case, (capabilities, query, info)) in [
        // A zero mesh of a solid the adapter calls nonempty.
        (32, 0, zero),
        // Partial metadata never reaches the certificate.
        (32, 1, [1, 0, 0, 0, 0, 0]),
        (32, 1, [0, 1, 0, 0, 0, 0]),
        (32, 1, [0, 0, 1, 0, 0, 0]),
        (32, 1, [0, 0, 0, 1, 0, 0]),
        (32, 1, [0, 0, 0, 0, 1, 0]),
        (32, 1, [0, 0, 0, 0, 0, 1]),
        (32, 0, [1, 1, 1, 0, 0, 1]),
        // Out-of-domain answer, and an adapter that cannot certify at all.
        (32, 2, zero),
        (11, 1, zero),
    ]
    .into_iter()
    .enumerate()
    {
        let worker = tessellate(case, capabilities, query, info);
        assert_eq!(worker.incarnation(), 0, "case {case} must retire");
    }
}

#[test]
fn certified_zero_metadata_seals_empty_and_keeps_worker() {
    let worker = tessellate(100, 32 | 11, 1, [0; 6]);
    assert_ne!(worker.incarnation(), 0);
}
