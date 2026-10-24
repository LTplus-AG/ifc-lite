// SPDX-License-Identifier: MPL-2.0
//! #7955 actual native Worker, source-derived constructions and affine receipts.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion, RetainedRequest};
use ifc_lite_geometry_runtime::{MeshLimits, RetainedTransformInput, SmlibWorker};
fn request(worker: &SmlibWorker, entity: u32) -> RetainedRequest {
    let text=format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);#4=IFCDIRECTION((0.,0.,1.));#{entity}=IFCEXTRUDEDAREASOLID(#3,$,#4,3.);");
    let source = SourceBundle::new(text.into_bytes());
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(entity).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    let mut doc = GeometryDocument::new();
    let id = doc
        .add_retained_extrusion(RetainedExtrusion {
            source,
            length_unit_scale: 1.,
        })
        .unwrap();
    doc.prepare_retained(id, worker.incarnation())
        .unwrap()
        .with_source_contract(0, 11)
        .unwrap()
}
#[test]
fn j5_actual_worker_source_roles_survive_nonuniform_reflection_and_source_release() {
    let Ok(path) = std::env::var("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP: configure IFCLITE_SMLIB_WORKER for real source correspondence");
        return;
    };
    let mut worker = SmlibWorker::spawn(&path).unwrap();
    let request_a = request(&worker, 5);
    let request_b = request(&worker, 6);
    let a = worker
        .evaluate_retained(request_a, 0.001, 5., MeshLimits::default())
        .unwrap();
    let b = worker
        .evaluate_retained(request_b, 0.001, 5., MeshLimits::default())
        .unwrap();
    let original = a.source_correspondence().unwrap().clone();
    assert!(!original.same_source(b.source_correspondence().unwrap()));
    assert_eq!(original.roles().len(), 6);
    assert!(!original.triangle_roots().is_empty());
    let matrix = [
        -2., 0., 0., 0., 0., 3., 0., 0., 0., 0., 0.5, 0., 7., -1., 2., 1.,
    ];
    let copied = worker
        .copy_retained_affine(RetainedTransformInput::Source(&a), matrix)
        .unwrap();
    assert!(original.same_source(copied.source_correspondence().unwrap()));
    let old = a.solid();
    drop(a);
    worker.flush_releases().unwrap();
    assert!(worker
        .tessellate(old, 0.001, 5., MeshLimits::default())
        .is_err());
    let mesh = worker
        .tessellate(copied.solid(), 0.001, 5., MeshLimits::default())
        .unwrap();
    let proof = mesh.source_correspondence.as_ref().unwrap();
    assert!(original.same_source(proof));
    assert_eq!(proof.triangle_roots().len(), mesh.indices.len() / 3);
    let mut foreign = SmlibWorker::spawn(&path).unwrap();
    assert!(foreign
        .copy_retained_affine(RetainedTransformInput::Affine(&copied), matrix)
        .is_err());
    drop(worker);
    assert!(copied.validate_live().is_err());
    b.validate_live().unwrap_err();
}
