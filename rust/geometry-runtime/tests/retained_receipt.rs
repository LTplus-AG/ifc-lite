// SPDX-License-Identifier: MPL-2.0
//! Synthetic 2x4x3 source invariant, actual SDK receipt and lifecycle (review 1-4).
//! This is not a real-authoring-tool IFC or broad geometry qualification witness.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_geometry::analytic::extract_analytic_extrusion;
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::document::{
    EvaluationContract, GeometryDocument, RetainedExtrusion, RetainedRequest,
};
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker, WorkerError};

fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!(
            "SKIP actual SDK retained receipt: build pinned adapter and set IFCLITE_SMLIB_WORKER"
        );
        return None;
    };
    Some(SmlibWorker::spawn(path).unwrap())
}
fn request(worker: &SmlibWorker) -> (GeometryDocument, RetainedRequest) {
    let input = b"#1=IFCCARTESIANPOINT((1.,2.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,3.);";
    let mut decoder = EntityDecoder::with_index(input, build_entity_index(input));
    let entity = decoder.decode_by_id(5).unwrap();
    let source = extract_analytic_extrusion(&entity, &mut decoder);
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion {
            source,
            length_unit_scale: 1.,
            source_epoch: 1,
            source_revision: 1,
        })
        .unwrap();
    let request = document
        .prepare_retained_extrusion(
            definition,
            EvaluationContract::RetainedBrep,
            worker.incarnation(),
        )
        .unwrap();
    (document, request)
}
#[test]
fn actual_sdk_receipt_binds_exact_packet_handle_and_live_owner() {
    let Some(mut worker) = worker() else { return };
    let (mut document, request) = request(&worker);
    let receipt = worker
        .evaluate_retained_extrusion(request, 0.001, 15., MeshLimits::default())
        .unwrap();
    receipt.validate_live().unwrap();
    let solid = receipt.solid();
    assert!((worker.volume(solid, 1e-8).unwrap() - 24.).abs() < 1e-6);
    assert!(worker.is_manifold(solid).unwrap());
    let packet = receipt.completion();
    assert!(!packet.tessellation.indices.is_empty());
    for (axis, expected) in [2., 4., 3.].into_iter().enumerate() {
        let coordinates: Vec<_> = packet
            .tessellation
            .positions
            .chunks_exact(3)
            .map(|v| v[axis])
            .collect();
        let min = coordinates.iter().copied().fold(f64::INFINITY, f64::min);
        let max = coordinates
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(min.abs() < 1e-6 && (max - expected).abs() < 1e-6);
    }
    let owner = receipt.owner().clone();
    let pid = worker.process_id();
    owner.retire();
    assert_eq!(worker.incarnation(), 0);
    assert!(receipt.validate_live().is_err());
    assert!(document
        .publish_retained_display(receipt.completion(), owner.incarnation().unwrap_or(0), &[])
        .is_err());
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    // The exact owned buffers remain available for rejection diagnostics.
    assert!(!receipt.completion().tessellation.positions.is_empty());
}
#[test]
fn actual_sdk_retained_limit_error_with_successful_cleanup_preserves_session() {
    let Some(mut worker) = worker() else { return };
    let (_, request) = request(&worker);
    let old = worker.incarnation();
    assert!(matches!(
        worker.evaluate_retained_extrusion(request, 0.001, 15., MeshLimits { max_bytes: 0 }),
        Err(WorkerError::ResourceLimit(_))
    ));
    assert_eq!(worker.incarnation(), old);
    let solid = worker.create_box([0.; 3], [2.; 3]).unwrap();
    assert!((worker.volume(solid, 1e-8).unwrap() - 8.).abs() < 1e-6);
    worker.release(solid).unwrap();
}
