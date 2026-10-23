// SPDX-License-Identifier: MPL-2.0
//! Affine-copy failure isolation through the public API, against a protocol
//! peer. Lifetime evidence only; numerical witnesses are in affine_copy.rs and
//! the native affine failure CTest.
#![cfg(unix)]
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion};
use ifc_lite_geometry_runtime::{
    MeshLimits, RetainedRealization, RetainedTransformInput, SmlibWorker, WorkerError,
};
use std::path::Path;

const SCALE: [f64; 16] = [
    2., 0., 0., 0., 0., 3., 0., 0., 0., 0., 4., 0., 0., 0., 0., 1.,
];

/// A rectangle needs no curved witness, so the peer can serve it.
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

/// Copy one live receipt on a peer answering opcode 18 as `mode` says.
fn attempt(mode: &str) -> (SmlibWorker, RetainedRealization, Result<(), WorkerError>) {
    let directory =
        std::env::temp_dir().join(format!("ifclite-affine-{}-{mode}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir(&directory).unwrap();
    let peer = directory.join("peer");
    std::os::unix::fs::symlink(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/affine-copy-peer.py"),
        &peer,
    )
    .unwrap();
    std::fs::write(directory.join("mode"), mode).unwrap();
    let mut worker = SmlibWorker::spawn(&peer).unwrap();
    let source = receipt(&mut worker);
    let result = worker
        .copy_retained_affine(RetainedTransformInput::Source(&source), SCALE)
        .map(drop);
    std::fs::remove_dir_all(directory).unwrap();
    (worker, source, result)
}

#[test]
fn tainted_affine_copy_tears_down_the_whole_domain() {
    let (mut worker, source, result) = attempt("taint");
    assert!(matches!(result, Err(WorkerError::Kernel { status: 8, .. })));
    assert_eq!(worker.incarnation(), 0);
    assert!(source.validate_live().is_err());
    assert!(matches!(
        worker.create_box([0.; 3], [1.; 3]),
        Err(WorkerError::Protocol(_))
    ));
}

#[test]
fn malformed_affine_reply_retires_the_worker() {
    let (worker, source, result) = attempt("short");
    assert!(matches!(result, Err(WorkerError::Protocol(_))));
    assert_eq!(worker.incarnation(), 0);
    assert!(source.validate_live().is_err());
}

#[test]
fn refused_or_unavailable_affine_copy_keeps_worker_and_input() {
    for (mode, status) in [("refuse", Some(7)), ("unavailable", None)] {
        let (worker, source, result) = attempt(mode);
        match (status, result) {
            (Some(expected), Err(WorkerError::Kernel { status, .. })) => {
                assert_eq!(status, expected)
            }
            (None, Err(WorkerError::Protocol(message))) => {
                assert_eq!(message, "affine rational copy extension unavailable")
            }
            (_, other) => panic!("{mode}: {other:?}"),
        }
        assert_ne!(worker.incarnation(), 0, "{mode}");
        source.validate_live().unwrap();
    }
}
