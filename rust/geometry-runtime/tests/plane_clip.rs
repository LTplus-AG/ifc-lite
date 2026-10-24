// SPDX-License-Identifier: MPL-2.0
//! #7955: Actual gated SDK candidates for opcode20 runtime binding; UNRUN at delivery.
//! Synthetic source invariants, not real-model or whole-product qualification.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{
    analytic::{extract_analytic_extrusion, with_source_capture},
    document::{GeometryDocument, RetainedExtrusion, RetainedRequest},
};
use ifc_lite_geometry_runtime::protocol::BooleanOperation;
use ifc_lite_geometry_runtime::{
    MeshLimits, PlaneClipMode as Mode, PlaneSide as Side, RetainedDependency as Input,
    RetainedLineage, RetainedRealization, RetainedTransformInput, SmlibWorker, WorkerError,
};
const I: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];
fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual plane runtime: build pinned adapter and set IFCLITE_SMLIB_WORKER");
        return None;
    };
    Some(SmlibWorker::spawn(path).unwrap())
}
fn request(w: &SmlibWorker, circle: bool) -> RetainedRequest {
    let profile = if circle {
        "IFCCIRCLEPROFILEDEF(.AREA.,$,#2,1.)"
    } else {
        "IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,2.)"
    };
    let input=format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3={profile};#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,2.);");
    let mut d = EntityDecoder::with_index(input.as_bytes(), build_entity_index(input.as_bytes()));
    let entity = d.decode_by_id(5).unwrap();
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion {
            source: with_source_capture(|| extract_analytic_extrusion(&entity, &mut d)),
            length_unit_scale: 1.,
        })
        .unwrap();
    document
        .prepare_retained(definition, w.incarnation())
        .unwrap()
}
fn source(s: &RetainedRealization, frame: [f64; 16]) -> Input<'_> {
    Input::Source {
        realization: s,
        world_from_source: frame,
    }
}
#[test]
fn actual_plane_runtime_box_survey_frame_single_clip_feeds_boolean_and_releases_independently() {
    let Some(mut w) = worker() else { return };
    let request = request(&w, false);
    let s = w
        .evaluate_retained(request.clone(), 0.001, 5., MeshLimits::default())
        .unwrap();
    let frame = [
        0., 1., 0., 0., -1., 0., 0., 0., 0., 0., 1., 0., 3e8, 4e8, 5e8, 1.,
    ];
    let plane = [0., 0., 1., 0., 0., 2.];
    let c = w
        .clip_retained_plane(
            source(&s, frame),
            plane,
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!((w.volume(c.solid(), 1e-8).unwrap() - 4.).abs() < 1e-6);
    assert!((w.volume(s.solid(), 1e-8).unwrap() - 8.).abs() < 1e-6);
    let expected_frame =
        ifc_lite_geometry_runtime_frame(frame, s.completion().source_from_evaluation);
    assert_eq!(*c.world_from_evaluation(), expected_frame);
    assert_eq!(c.operation_identity().input, s.solid());
    assert_eq!(c.operation_identity().plane, plane);
    let RetainedLineage::PlaneClip {
        input, certificate, ..
    } = c.lineage()
    else {
        panic!("missing unary ancestry")
    };
    assert!(std::sync::Arc::ptr_eq(
        certificate,
        &c.operation_identity().certificate
    ));
    let RetainedLineage::Source {
        request: original, ..
    } = input.as_ref()
    else {
        panic!("missing source")
    };
    assert_eq!(original.definition(), request.definition());
    assert_eq!(original.document_revision(), request.document_revision());
    assert_eq!(original.worker_incarnation(), request.worker_incarnation());
    assert_eq!(original.recipe(), request.recipe());
    // #7955: a second finite cut must produce the z=[1,1.5] slab.
    let chained = w.clip_retained_plane(
        Input::Clip(&c), [0., 0., 1.5, 0., 0., 1.], Side::Positive,
        Mode::Difference, 0.001, 5., MeshLimits::default(),
    ).unwrap();
    assert!((w.volume(chained.solid(), 1e-8).unwrap() - 2.).abs() < 1e-6);
    c.validate_live().unwrap();
    s.validate_live().unwrap();
    assert_ne!(w.incarnation(), 0);
    let affine = w
        .copy_retained_affine(RetainedTransformInput::Clip(&c), I)
        .unwrap();
    assert!((w.volume(affine.solid(), 1e-8).unwrap() - 4.).abs() < 1e-6);
    let result = w
        .evaluate_retained_boolean(
            Input::Clip(&c),
            source(&s, frame),
            BooleanOperation::Intersection,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!((w.volume(result.solid(), 1e-8).unwrap() - 4.).abs() < 1e-6);
    let replacement = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 7e7, 8e7, 9e7, 1.,
    ];
    let placed = w
        .evaluate_retained_boolean(
            Input::PlacedClip {
                clip: &c,
                world_from_clip: replacement,
            },
            Input::PlacedClip {
                clip: &c,
                world_from_clip: replacement,
            },
            BooleanOperation::Intersection,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert_eq!(placed.world_from_evaluation(), &replacement);
    assert!((w.volume(placed.solid(), 1e-8).unwrap() - 4.).abs() < 1e-6);
    for scale in [2., -1., f64::NAN] {
        let mut invalid = replacement;
        invalid[0] = scale;
        assert!(w
            .clip_retained_plane(
                Input::PlacedClip {
                    clip: &c,
                    world_from_clip: invalid
                },
                plane,
                Side::Positive,
                Mode::Intersection,
                0.001,
                5.,
                MeshLimits::default()
            )
            .is_err());
        c.validate_live().unwrap();
    }
    let copied = w.copy_retained_affine(RetainedTransformInput::Source(&s), I).unwrap();
    let copied_clip = w.clip_retained_plane(
        Input::Affine { copy: &copied, world_from_affine: frame }, plane,
        Side::Positive, Mode::Intersection, 0.001, 5., MeshLimits::default(),
    ).unwrap();
    assert!((w.volume(copied_clip.solid(), 1e-8).unwrap() - 4.).abs() < 1e-6);
    copied.validate_live().unwrap();
    s.validate_live().unwrap();
    let combined = w
        .evaluate_retained_boolean(
            source(&s, frame),
            source(&s, frame),
            BooleanOperation::Union,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    let from_result = w
        .clip_retained_plane(
            Input::Result(&combined),
            plane,
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!((w.volume(from_result.solid(), 1e-8).unwrap() - 4.).abs() < 1e-6);
    let old = c.solid();
    drop(s);
    drop(c);
    drop(combined);
    drop(copied);
    w.flush_releases().unwrap();
    assert!(matches!(w.volume(old, 1e-8), Err(WorkerError::WrongWorker)));
    for retained in [&result, &placed] {
        retained.validate_live().unwrap();
    }
    chained.validate_live().unwrap();
    copied_clip.validate_live().unwrap();
    affine.validate_live().unwrap();
    from_result.validate_live().unwrap();
    w.release(result.solid()).unwrap();
    assert!(result.validate_live().is_err());
    from_result.validate_live().unwrap();
}
fn ifc_lite_geometry_runtime_frame(a: [f64; 16], b: [f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| (0..4).map(|k| a[4 * k + i % 4] * b[4 * (i / 4) + k]).sum())
}
#[test]
fn actual_plane_runtime_cylinder_empty_and_empty_chaining_use_semantic_query() {
    let Some(mut w) = worker() else { return };
    w.qualify_ordered_regions().unwrap();
    let request = request(&w, true);
    let s = w
        .evaluate_retained(request, 0.001, 5., MeshLimits::default())
        .unwrap();
    let c = w
        .clip_retained_plane(
            source(&s, I),
            [0., 0., 1., 0., 0., 1.],
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!((w.volume(c.solid(), 1e-8).unwrap() - std::f64::consts::PI).abs() < 1e-6);
    assert!(w.is_manifold(c.solid()).unwrap());
    assert!(!w.is_empty(c.solid()).unwrap());
    let empty = w
        .clip_retained_plane(
            source(&s, I),
            [0., 0., 3., 0., 0., 1.],
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!(empty.is_empty());
    assert!(w.is_empty(empty.solid()).unwrap());
    assert!(empty.mesh().indices.is_empty());
    let again = w
        .clip_retained_plane(
            Input::Clip(&empty),
            [0., 0., 1., 0., 0., 1.],
            Side::Negative,
            Mode::Difference,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(again.operation_identity().certificate.method(), 0);
    let copied = w
        .copy_retained_affine(RetainedTransformInput::Clip(&empty), I)
        .unwrap();
    let affine_empty = w
        .clip_retained_plane(
            Input::Affine {
                copy: &copied,
                world_from_affine: I,
            },
            [0., 0., 1., 0., 0., 1.],
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default(),
        )
        .unwrap();
    assert!(affine_empty.is_empty());
    assert!(w.is_empty(affine_empty.solid()).unwrap());
    drop(empty);
    drop(copied);
    w.flush_releases().unwrap();
    affine_empty.validate_live().unwrap();
    again.validate_live().unwrap();

    assert!((w.volume(s.solid(), 1e-8).unwrap() - 2. * std::f64::consts::PI).abs() < 1e-6);
}
#[test]
fn actual_plane_runtime_rejects_foreign_released_and_invalid_without_retiring_inputs() {
    let Some(mut a) = worker() else { return };
    let Some(mut b) = worker() else { return };
    let r = request(&a, false);
    let s = a
        .evaluate_retained(r, 0.001, 5., MeshLimits::default())
        .unwrap();
    assert!(matches!(
        b.clip_retained_plane(
            source(&s, I),
            [0., 0., 1., 0., 0., 1.],
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default()
        ),
        Err(WorkerError::WrongWorker)
    ));
    assert!(a
        .clip_retained_plane(
            source(&s, I),
            [0.; 6],
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default()
        )
        .is_err());
    s.validate_live().unwrap();
    assert_ne!(b.incarnation(), 0);
    a.release(s.solid()).unwrap();
    assert!(a
        .clip_retained_plane(
            source(&s, I),
            [0., 0., 1., 0., 0., 1.],
            Side::Positive,
            Mode::Intersection,
            0.001,
            5.,
            MeshLimits::default()
        )
        .is_err());
    assert_ne!(a.incarnation(), 0);
}

#[test]
fn actual_plane_runtime_offcentre_box_both_sides_and_modes_match_source_volume() {
    // #7955: a 2x2x2 extrusion clipped at z=0.5 has 6m3 above and 2m3 below.
    // Fixed before SDK execution: absolute volume tolerance 1e-6m3, query 1e-8.
    let Some(mut w) = worker() else { return };
    let request = request(&w, false);
    let s = w
        .evaluate_retained(request, 0.001, 5., MeshLimits::default())
        .unwrap();
    for side in [Side::Positive, Side::Negative] {
        for mode in [Mode::Intersection, Mode::Difference] {
            let result = w
                .clip_retained_plane(
                    source(&s, I),
                    [0., 0., 0.5, 0., 0., 2.],
                    side,
                    mode,
                    0.001,
                    5.,
                    MeshLimits::default(),
                )
                .unwrap();
            let expected = if (side == Side::Positive) == (mode == Mode::Intersection) {
                6.
            } else {
                2.
            };
            assert!((w.volume(result.solid(), 1e-8).unwrap() - expected).abs() < 1e-6);
            assert!(w.is_manifold(result.solid()).unwrap());
            assert!(!w.is_empty(result.solid()).unwrap());
            assert!((w.volume(s.solid(), 1e-8).unwrap() - 8.).abs() < 1e-6);
        }
    }
}
