// SPDX-License-Identifier: MPL-2.0
//! Exact source-to-coefficient invariants of wire format 2, its frames and
//! strict refusals. Nothing here evaluates or tessellates a disk.

use super::*;
use crate::analytic::{extract_swept_disk, with_source_capture};
use crate::document::{
    GeometryDocument, RetainedCompletion, RetainedDisplayContract, RetainedRecipe,
    RetainedTessellation,
};
use ifc_lite_core::{build_entity_index, EntityDecoder};

fn read_with(data: &str, units: f64, capture: bool) -> RetainedSweptDisk {
    let mut decoder =
        EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let entity = decoder.decode_by_id(9).unwrap();
    let source = if capture {
        with_source_capture(|| extract_swept_disk(&entity, &mut decoder)).unwrap()
    } else {
        extract_swept_disk(&entity, &mut decoder).unwrap()
    };
    RetainedSweptDisk {
        solid_id: 9,
        source,
        length_unit_scale: units,
    }
}

fn read(data: &str, units: f64) -> RetainedSweptDisk {
    read_with(data, units, true)
}

fn number(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// Survey-scale rational line in millimetres, StartParam 3 and EndParam 5.
const RATIONAL: &str = "#1=IFCCARTESIANPOINT((1000000000.,0.,0.));#2=IFCCARTESIANPOINT((1000000000.,0.,5000.));#3=IFCRATIONALBSPLINECURVEWITHKNOTS(1,(#1,#2),.UNSPECIFIED.,.F.,.F.,(2,2),(2.,6.),.UNSPECIFIED.,(2.,3.));#9=IFCSWEPTDISKSOLID(#3,250.,$,3.,5.);";
const QUARTER: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCCIRCLE(#2,4.);#4=IFCTRIMMEDCURVE(#3,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5707963267948966)),.T.,.PARAMETER.);#9=IFCSWEPTDISKSOLID(#4,0.25,$,$,$);";

#[test]
fn original_rational_weights_knots_and_trim_survive_unit_conversion_and_rebase() {
    let recipe = read(RATIONAL, 0.001);
    let original = recipe.source.clone();
    let payload = lower(&recipe).unwrap();
    assert_eq!(recipe.source, original, "the recipe is never modified");
    assert_eq!((payload.format, payload.loops, payload.segments), (2, 1, 1));
    assert_eq!(payload.qualification, RegionQualification::RationalDisk);
    let bytes = &payload.bytes;
    assert_eq!([word(bytes, 0), word(bytes, 4), word(bytes, 8)], [2, 1, 1]);
    assert_eq!((number(bytes, 16), number(bytes, 24)), (0.25, 0.0));
    // Kind, degree, control count and unique knot count.
    assert_eq!(
        [
            word(bytes, 32),
            word(bytes, 40),
            word(bytes, 44),
            word(bytes, 48)
        ],
        [4, 1, 2, 2]
    );
    // The authored StartParam/EndParam, in the curve's own basis parameter.
    assert_eq!((number(bytes, 56), number(bytes, 64)), (3.0, 5.0));
    // Control 0 is the anchor; control 1 is 5000 mm above it, in metres. The
    // original weights are kept, not normalized.
    assert_eq!(
        [number(bytes, 72), number(bytes, 88), number(bytes, 96)],
        [0.0, 0.0, 2.0]
    );
    assert_eq!(
        [number(bytes, 104), number(bytes, 120), number(bytes, 128)],
        [0.0, 5.0, 3.0]
    );
    assert_eq!([number(bytes, 136), number(bytes, 152)], [2.0, 6.0]);
    assert_eq!([word(bytes, 144), word(bytes, 160)], [2, 2]);
    assert_eq!(bytes.len(), 72 + 2 * 32 + 2 * 16);
    // The survey-scale anchor stays in the f64 frame, never in the payload.
    assert_eq!(payload.source_from_evaluation[0], 1000.0);
    assert_eq!(payload.source_from_evaluation[12], 1e9);
    assert_eq!(payload.evaluation_from_source[0], 0.001);
    assert_eq!(payload.evaluation_from_source[12], -1e6);
}

#[test]
fn circular_conic_conversion_is_exact_and_keeps_the_original_circle() {
    let recipe = read(QUARTER, 1.0);
    let original = recipe.source.clone();
    let payload = lower(&recipe).unwrap();
    assert_eq!(recipe.source, original);
    let bytes = &payload.bytes;
    // A quarter circle is one exact quadratic rational span, not a fit.
    assert_eq!(
        [word(bytes, 40), word(bytes, 44), word(bytes, 48)],
        [2, 3, 2]
    );
    assert_eq!((number(bytes, 56), number(bytes, 64)), (0.0, 1.0));
    let control = |i: usize| {
        let at = 72 + 32 * i;
        (
            [
                number(bytes, at),
                number(bytes, at + 8),
                number(bytes, at + 16),
            ],
            number(bytes, at + 24),
        )
    };
    assert!((control(1).1 - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-15);
    // Every evaluated point lies on the authored circle (centre (-4, 0, 0)
    // relative to the anchor), so the derived curve is the circle itself.
    for t in [0.0, 0.1, 0.25, 0.5, 0.9, 1.0] {
        let basis = [(1.0 - t) * (1.0 - t), 2.0 * t * (1.0 - t), t * t];
        let mut point = [0.0; 3];
        let mut denominator = 0.0;
        for (i, b) in basis.iter().enumerate() {
            let (p, w) = control(i);
            denominator += b * w;
            for axis in 0..3 {
                point[axis] += b * w * p[axis];
            }
        }
        let distance =
            ((point[0] / denominator + 4.0).powi(2) + (point[1] / denominator).powi(2)).sqrt();
        assert!((distance - 4.0).abs() < 1e-14, "t={t}: {distance}");
    }
    let source = recipe.source.source.as_ref().unwrap();
    assert_eq!(source.records[&3].ifc_type_name, "IfcCircle");
    assert!(source.records[&4].attributes.contains_key("Trim1"));
}

#[test]
fn larger_arcs_split_into_quarter_turn_spans_and_lines_into_degree_one() {
    let three_quarters = QUARTER.replace("1.5707963267948966", "4.5");
    let payload = lower(&read(&three_quarters, 1.0)).unwrap();
    let bytes = &payload.bytes;
    assert_eq!(
        [word(bytes, 40), word(bytes, 44), word(bytes, 48)],
        [2, 7, 4]
    );
    let knots = 72 + 7 * 32;
    let multiplicities: Vec<_> = (0..4).map(|i| word(bytes, knots + 16 * i + 8)).collect();
    assert_eq!(multiplicities, [3, 2, 2, 3]);
    assert_eq!((number(bytes, 56), number(bytes, 64)), (0.0, 3.0));

    let line = "#1=IFCCARTESIANPOINT((10.,20.,0.));#2=IFCCARTESIANPOINT((10.,20.,5.));#3=IFCPOLYLINE((#1,#2));#9=IFCSWEPTDISKSOLID(#3,0.25,$,$,$);";
    let payload = lower(&read(line, 1.0)).unwrap();
    let bytes = &payload.bytes;
    assert_eq!(
        [word(bytes, 40), word(bytes, 44), word(bytes, 48)],
        [1, 2, 2]
    );
    assert_eq!(
        [number(bytes, 104), number(bytes, 112), number(bytes, 120)],
        [0.0, 0.0, 5.0]
    );
    assert_eq!(payload.source_from_evaluation[12..15], [10.0, 20.0, 0.0]);
}

#[test]
fn unsupported_disk_families_keep_named_refusals() {
    let hollow = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((0.,0.,5.));#3=IFCPOLYLINE((#1,#2));#9=IFCSWEPTDISKSOLID(#3,0.25,0.1,$,$);";
    let circle = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCCIRCLE(#2,4.);#9=IFCSWEPTDISKSOLID(#3,0.25,$,$,$);";
    let kinked = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((0.,0.,5.));#4=IFCCARTESIANPOINT((5.,0.,5.));#3=IFCPOLYLINE((#1,#2,#4));#9=IFCSWEPTDISKSOLID(#3,0.25,$,$,$);";
    let ellipse = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCELLIPSE(#2,4.,2.);#9=IFCSWEPTDISKSOLID(#3,0.25,$,$,$);";
    for (data, expected) in [
        (hollow, "hollow"),
        (circle, "closed circular"),
        (kinked, "multi-segment"),
        (ellipse, "unsupported"),
    ] {
        match lower(&read(data, 1.0)) {
            Err(RetainedRefusal::UnsupportedSource(reason)) => {
                assert!(reason.contains(expected), "{expected}: {reason}")
            }
            other => panic!("{expected}: {other:?}"),
        }
    }
}

#[test]
fn uncaptured_or_inconsistent_sources_are_refused_without_changing_the_document() {
    let mut document = GeometryDocument::new();
    assert_eq!(
        document.add_retained_swept_disk(read_with(RATIONAL, 0.001, false)),
        Err(RetainedRefusal::SourceNotCaptured)
    );
    let mut foreign = read(RATIONAL, 0.001);
    foreign.solid_id = 3;
    let mut weightless = read(RATIONAL, 0.001);
    let Some(OwnedDirectrix::Rational(curve)) = weightless.source.owned_directrix.as_mut() else {
        panic!("rational directrix is owned");
    };
    curve.weights[1] = 0.0;
    let mut widened = read(RATIONAL, 0.001);
    let Some(OwnedDirectrix::Rational(curve)) = widened.source.owned_directrix.as_mut() else {
        panic!("rational directrix is owned");
    };
    curve.parameter_range = [1.0, 5.0];
    let mut huge = read(RATIONAL, 0.001);
    huge.source.radius = 1e13;
    let mut unitless = read(RATIONAL, 0.001);
    unitless.length_unit_scale = 0.0;
    for recipe in [foreign, weightless, widened, huge, unitless] {
        assert!(
            matches!(
                document.add_retained_swept_disk(recipe),
                Err(RetainedRefusal::InvalidSource(_))
            ),
            "inconsistent source admitted"
        );
    }
    assert_eq!(document.revision(), 0);
}

#[test]
fn retained_disk_reaches_display_only_through_the_single_contract() {
    let mut document = GeometryDocument::new();
    let recipe = read(RATIONAL, 0.001);
    let handle = document.add_retained_swept_disk(recipe.clone()).unwrap();
    assert_eq!(document.revision(), 1);
    assert_eq!(
        document.retained_recipe(handle).unwrap(),
        &RetainedRecipe::SweptDisk(recipe)
    );
    let request = document.prepare_retained(handle, 3).unwrap();
    assert_eq!(request.recipe().solid_id(), 9);
    assert_eq!(request.payload().format, 2);
    let frames = |request: &crate::document::RetainedRequest| {
        (
            request.payload().source_from_evaluation,
            request.payload().evaluation_from_source,
        )
    };
    let tessellation = RetainedTessellation {
        positions: vec![0., 0., 0., 1., 0., 0., 0., 1., 0.],
        indices: vec![0, 1, 2],
        flat_corner_normals: vec![0., 0., 1., 0., 0., 1., 0., 0., 1.],
        revision_local_faces: vec![0],
        source_face_count: 1,
        boundary_edges: 0,
        spine_edges: 0,
    };
    let (from, mut to) = frames(&request);
    to[12] = 0.0;
    let shifted = RetainedCompletion::new(request.clone(), tessellation.clone(), from, to);
    let identity = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ];
    assert_eq!(
        document.publish_retained_display(
            &shifted,
            3,
            RetainedDisplayContract::UnstyledFlatSourceOnly,
            &[(50, identity)]
        ),
        Err(RetainedRefusal::FrameMismatch)
    );
    let (from, to) = frames(&request);
    let packet = RetainedCompletion::new(request, tessellation, from, to);
    assert_eq!(
        document.publish_retained_display(
            &packet,
            3,
            RetainedDisplayContract::AnalyticSurfaceNormals,
            &[(50, identity)]
        ),
        Err(RetainedRefusal::AnalyticNormalsUnavailable)
    );
    assert_eq!(document.revision(), 1, "refusals change nothing");
    let (definition, occurrences) = document
        .publish_retained_display(
            &packet,
            3,
            RetainedDisplayContract::UnstyledFlatSourceOnly,
            &[(50, identity)],
        )
        .unwrap();
    // A display approximation attributed to the authored solid; the retained
    // source stays beside it, unchanged.
    assert_eq!(document.source_entity_id(definition), Ok(9));
    assert_eq!(occurrences.len(), 1);
    assert!(matches!(
        document.retained_recipe(handle),
        Ok(RetainedRecipe::SweptDisk(_))
    ));
}
