// SPDX-License-Identifier: MPL-2.0
//! Bounded affine copies on an actual SMLib worker: proper conversion of the
//! actual solid, immutable inputs, independently owned copies, full lineage
//! and explicit placement into retained Booleans.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion, RetainedRequest};
use ifc_lite_geometry_runtime::protocol::BooleanOperation;
use ifc_lite_geometry_runtime::{
    MeshLimits, RetainedDependency, RetainedLineage, RetainedRealization, RetainedTransformInput,
    SmlibWorker, WorkerError,
};

const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];
/// Reflecting nonuniform scale, determinant -6.
const REFLECTED: [f64; 16] = [
    -2., 0., 0., 0., 0., 3., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];
/// Shear with an independent Z row, determinant 1.
const SHEAR: [f64; 16] = [
    1., 0., 0., 0., 0.5, 1., 0., 0., 0.2, 0.3, 1., 0., 5., -3., 1., 1.,
];

fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!(
            "SKIP actual affine copies: build native/smlib-adapter and set IFCLITE_SMLIB_WORKER"
        );
        return None;
    };
    Some(SmlibWorker::spawn(path).expect("configured worker must start"))
}

/// A 2 x 4 x 3 m rectangle extrusion (24 m3) with its minimum corner at the origin.
fn request(worker: &SmlibWorker) -> RetainedRequest {
    let data = "#1=IFCCARTESIANPOINT((1.,2.));#2=IFCAXIS2PLACEMENT2D(#1,$);\
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
    document
        .prepare_retained(definition, worker.incarnation())
        .unwrap()
}

fn evaluate(worker: &mut SmlibWorker, request: RetainedRequest) -> RetainedRealization {
    worker
        .evaluate_retained(request, 0.001, 5., MeshLimits::default())
        .unwrap()
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= expected * 1e-5,
        "{actual} != {expected}"
    );
}

fn shifted(dx: f64) -> [f64; 16] {
    let mut frame = IDENTITY;
    frame[12] = dx;
    frame
}

#[test]
fn actual_sdk_affine_copies_are_independent_and_keep_full_lineage() {
    let Some(mut worker) = worker() else { return };
    let incarnation = worker.incarnation();
    let request = request(&worker);
    let source = evaluate(&mut worker, request.clone());

    let first = worker
        .copy_retained_affine(RetainedTransformInput::Source(&source), REFLECTED)
        .unwrap();
    let identity = first.operation_identity();
    assert_eq!(identity.input, source.solid());
    assert_eq!(identity.column_major, REFLECTED);
    assert_eq!(
        identity.certificate.representation(),
        "generic-rational-brep-v1"
    );
    let classes = identity.certificate.source_classes();
    // An extruded rectangle: twelve line edges and six plane faces.
    assert_eq!((classes[1], classes[7]), (12, 6), "{classes:?}");
    assert_eq!(classes.iter().sum::<u32>(), 18);
    assert_ne!(first.solid(), source.solid());
    close(worker.volume(first.solid(), 1e-8).unwrap(), 144.);
    assert!(worker.is_manifold(first.solid()).unwrap());
    // The input is never modified.
    close(worker.volume(source.solid(), 1e-8).unwrap(), 24.);

    let second = worker
        .copy_retained_affine(RetainedTransformInput::Affine(&first), SHEAR)
        .unwrap();
    close(worker.volume(second.solid(), 1e-8).unwrap(), 144.);
    close(worker.volume(first.solid(), 1e-8).unwrap(), 144.);

    // Copies own their geometry independently of the released source.
    worker.release(source.solid()).unwrap();
    assert!(source.validate_live().is_err());
    first.validate_live().unwrap();
    second.validate_live().unwrap();
    close(worker.volume(second.solid(), 1e-8).unwrap(), 144.);

    let RetainedLineage::AffineCopy {
        input,
        column_major,
        ..
    } = second.lineage()
    else {
        panic!("missing repeated-copy lineage");
    };
    assert_eq!(*column_major, SHEAR);
    let RetainedLineage::AffineCopy {
        input,
        column_major,
        certificate,
    } = input.as_ref()
    else {
        panic!("missing first copy lineage");
    };
    assert_eq!(*column_major, REFLECTED);
    assert_eq!(certificate, &first.operation_identity().certificate);
    let RetainedLineage::Definition {
        request: original,
        source_from_evaluation,
        ..
    } = input.as_ref()
    else {
        panic!("missing authored source");
    };
    assert_eq!(original.definition(), request.definition());
    assert_eq!(original.payload().bytes, request.payload().bytes);
    assert_eq!(
        *source_from_evaluation,
        request.payload().source_from_evaluation
    );

    // Explicitly placed copies enter Booleans; half of second overlaps first.
    let union = worker
        .evaluate_retained_boolean(
            RetainedDependency::Affine {
                copy: &first,
                world_from_affine: shifted(0.),
            },
            RetainedDependency::Affine {
                copy: &first,
                world_from_affine: shifted(2.),
            },
            BooleanOperation::Union,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    close(worker.volume(union.solid(), 1e-8).unwrap(), 216.);
    let RetainedLineage::Boolean { left, .. } = union.lineage() else {
        panic!("missing Boolean lineage");
    };
    assert!(matches!(left.as_ref(), RetainedLineage::Placed { .. }));
    assert!(matches!(
        worker.evaluate_retained_boolean(
            RetainedDependency::Affine {
                copy: &first,
                world_from_affine: REFLECTED,
            },
            RetainedDependency::Affine {
                copy: &second,
                world_from_affine: IDENTITY,
            },
            BooleanOperation::Union,
            0.001,
            5.,
            MeshLimits::default(),
        ),
        Err(WorkerError::InvalidArgument(_))
    ));

    let baked = worker
        .copy_retained_affine(RetainedTransformInput::Result(&union), REFLECTED)
        .unwrap();
    close(worker.volume(baked.solid(), 1e-8).unwrap(), 1296.);
    let RetainedLineage::AffineCopy { input, .. } = baked.lineage() else {
        panic!("missing result-copy lineage");
    };
    assert!(matches!(input.as_ref(), RetainedLineage::Boolean { .. }));

    // Dropping one copy releases only it; later values do not depend on it.
    let stale = first.solid();
    drop(first);
    assert!(matches!(
        worker.volume(stale, 1e-8),
        Err(WorkerError::WrongWorker)
    ));
    close(worker.volume(second.solid(), 1e-8).unwrap(), 144.);
    union.validate_live().unwrap();
    drop(union);
    close(worker.volume(baked.solid(), 1e-8).unwrap(), 1296.);
    let stale = baked.solid();
    drop(baked);
    let sibling = worker.create_box([0.; 3], [1.; 3]).unwrap();
    close(worker.volume(sibling, 1e-8).unwrap(), 1.);
    assert!(matches!(
        worker.volume(stale, 1e-8),
        Err(WorkerError::WrongWorker)
    ));
    second.validate_live().unwrap();
    assert_eq!(worker.incarnation(), incarnation);
}

#[test]
fn actual_sdk_refused_affine_copies_publish_nothing_and_keep_the_input() {
    let Some(mut worker) = worker() else { return };
    let incarnation = worker.incarnation();
    let request = request(&worker);
    let source = evaluate(&mut worker, request);
    let mut singular = IDENTITY;
    singular[10] = 0.;
    assert!(matches!(
        worker.copy_retained_affine(RetainedTransformInput::Source(&source), singular),
        Err(WorkerError::InvalidArgument(_))
    ));
    // Representable but outside the singular-value envelope: the adapter
    // refuses with status 7 before copying anything.
    let mut squashed = IDENTITY;
    squashed[10] = 1e-7;
    assert!(matches!(
        worker.copy_retained_affine(RetainedTransformInput::Source(&source), squashed),
        Err(WorkerError::Kernel { status: 7, .. })
    ));
    assert_eq!(worker.incarnation(), incarnation);
    source.validate_live().unwrap();
    close(worker.volume(source.solid(), 1e-8).unwrap(), 24.);
    // A certified-empty Boolean result copies to a certified-empty solid.
    let empty = worker
        .evaluate_retained_boolean(
            RetainedDependency::Source {
                realization: &source,
                world_from_source: IDENTITY,
            },
            RetainedDependency::Source {
                realization: &source,
                world_from_source: IDENTITY,
            },
            BooleanOperation::Difference,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!(empty.is_empty());
    let copy = worker
        .copy_retained_affine(RetainedTransformInput::Result(&empty), SHEAR)
        .unwrap();
    assert_eq!(
        copy.operation_identity().certificate.source_classes(),
        &[0; 12]
    );
    assert!(worker.is_empty(copy.solid()).unwrap());
    assert_eq!(worker.incarnation(), incarnation);
}
