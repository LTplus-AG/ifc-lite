// SPDX-License-Identifier: MPL-2.0
//! Retained rational swept-disk requests built from a model (F2c, #7955):
//! worker/revision/source identity, f64 frames, no falsely authored mesh,
//! strict supported/refusal families and the single retained display contract.

use ifc_lite_geometry::analytic::OwnedDirectrix;
use ifc_lite_geometry::document::{
    DocumentError, RegionQualification, RetainedCompletion, RetainedDisplayContract,
    RetainedRecipe, RetainedRefusal, RetainedTessellation,
};
use ifc_lite_processing::retained_requests::{RetainedSourceRefusal, RetainedSources};
use std::collections::HashSet;

fn fixture() -> String {
    std::fs::read_to_string("../geometry/tests/fixtures/swept_disk_trimmed_line.ifc").unwrap()
}

fn replaced(from: &str, to: &str) -> String {
    let model = fixture();
    assert!(model.contains(from), "fixture lost {from}");
    model.replace(from, to)
}

/// The fixture's trimmed line replaced by a survey-offset rational quarter
/// circle in millimetres, swept over its own basis parameter 3.5..4.5.
fn rational() -> String {
    replaced(
        "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
        "#60=IFCCARTESIANPOINT((2002000.,0.,0.));\n#61=IFCCARTESIANPOINT((2002000.,2000.,0.));\n\
#62=IFCCARTESIANPOINT((2000000.,2000.,0.));\n\
#63=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#60,#61,#62),.CIRCULAR_ARC.,.F.,.F.,(3,3),(2.,6.),.UNSPECIFIED.,(1.,0.7071067811865476,1.));\n\
#43=IFCSWEPTDISKSOLID(#63,14.5,$,3.5,4.5);",
    )
}

fn number(bytes: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

fn tessellation() -> RetainedTessellation {
    RetainedTessellation {
        positions: vec![0., 0., 0., 1., 0., 0., 0., 1., 0.],
        indices: vec![0, 1, 2],
        flat_corner_normals: vec![0., 0., 1., 0., 0., 1., 0., 0., 1.],
        revision_local_faces: vec![0],
        source_face_count: 1,
        boundary_edges: 0,
        spine_edges: 0,
    }
}

#[test]
fn rational_directrix_is_retained_with_its_original_coefficients_and_frame() {
    let sources = RetainedSources::swept_disks(rational().as_bytes(), None);
    assert!(sources.refused.is_empty(), "{:?}", sources.refused);
    assert_eq!(sources.admitted.len(), 1);
    let source = &sources.admitted[0];
    assert_eq!(source.key().solid_id, 43);
    assert_eq!(
        source.qualification(),
        Ok(RegionQualification::RationalDisk)
    );
    let Ok(RetainedRecipe::SweptDisk(recipe)) =
        source.document().retained_recipe(source.definition())
    else {
        panic!("swept disk retained as another family");
    };
    let Some(OwnedDirectrix::Rational(curve)) = &recipe.source.owned_directrix else {
        panic!("rational directrix not owned");
    };
    assert_eq!(curve.parameter_range, [3.5, 4.5]);
    assert!(
        recipe.source.segments.is_empty(),
        "no interpreted mesh segments"
    );
    let request = source.prepare(5).unwrap();
    let bytes = &request.payload().bytes;
    assert_eq!(request.payload().format, 2);
    assert_eq!(number(bytes, 16), 0.0145, "radius in metres");
    assert_eq!((number(bytes, 56), number(bytes, 64)), (3.5, 4.5));
    // Control 1 relative to the survey-offset anchor, in metres; weight kept.
    assert_eq!(
        [number(bytes, 104), number(bytes, 112), number(bytes, 120)],
        [0.0, 2.0, 0.0]
    );
    assert_eq!(number(bytes, 128), std::f64::consts::FRAC_1_SQRT_2);
    // Evaluation origin is the first control point, 2002 m along world X;
    // row-major world placement, f64 metres.
    let occurrences = source.occurrences();
    assert_eq!(occurrences.len(), 1);
    assert_eq!(occurrences[0].product_id, 50);
    let world = occurrences[0].world_from_evaluation;
    assert_eq!([world[3], world[7], world[11]], [2002.0, 0.0, 0.0]);
    assert_eq!([world[0], world[5], world[10], world[15]], [1.0; 4]);
}

#[test]
fn line_directrix_is_admitted_and_published_only_as_a_display_approximation() {
    let ids = HashSet::from([50]);
    let mut sources = RetainedSources::swept_disks(fixture().as_bytes(), Some(&ids));
    assert!(
        RetainedSources::swept_disks(fixture().as_bytes(), Some(&HashSet::new()))
            .admitted
            .is_empty()
    );
    assert!(
        RetainedSources::extrusions(fixture().as_bytes(), None)
            .admitted
            .is_empty(),
        "families are collected separately"
    );
    let source = &mut sources.admitted[0];
    let request = source.prepare(2).unwrap();
    assert_eq!(request.document_revision(), 1);
    assert_eq!(request.worker_incarnation(), 2);
    // An exact degree-1 line of 2750 mm along X.
    assert_eq!(number(&request.payload().bytes, 104), 2.75);
    let payload = request.payload();
    let (from, to) = (
        payload.source_from_evaluation,
        payload.evaluation_from_source,
    );
    let packet = RetainedCompletion::new(request, tessellation(), from, to);
    for (contract, refusal) in [
        (
            RetainedDisplayContract::PersistentIfcFaces,
            RetainedRefusal::PersistentFaceProvenanceUnavailable,
        ),
        (
            RetainedDisplayContract::IfcAppearance,
            RetainedRefusal::IfcAppearanceUnavailable,
        ),
    ] {
        assert_eq!(
            source.publish_display(&packet, 2, contract).unwrap_err(),
            refusal
        );
    }
    assert_eq!(
        source
            .publish_display(&packet, 9, RetainedDisplayContract::UnstyledFlatSourceOnly)
            .unwrap_err(),
        RetainedRefusal::WrongWorker
    );
    let published = source
        .publish_display(&packet, 2, RetainedDisplayContract::UnstyledFlatSourceOnly)
        .unwrap();
    let document = source.document();
    assert_eq!(document.source_entity_id(published.definition), Ok(43));
    assert_eq!(published.occurrences.len(), 1);
    let (product, handle) = published.occurrences[0];
    assert_eq!(product, 50);
    assert_eq!(
        document.occurrence(handle).unwrap().local_to_model,
        source.occurrences()[0].world_from_evaluation
    );
    assert!(document.retained_recipe(source.definition()).is_ok());
    // The packet is spent: publication advanced the revision.
    assert_eq!(
        source
            .publish_display(&packet, 2, RetainedDisplayContract::UnstyledFlatSourceOnly)
            .unwrap_err(),
        RetainedRefusal::Document(DocumentError::StaleRevision)
    );
}

#[test]
fn hollow_closed_and_boolean_disks_are_refused_by_name() {
    let hollow = replaced(
        "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
        "#43=IFCSWEPTDISKSOLID(#42,14.5,10.,0.,2750.);",
    );
    let closed = replaced(
        "#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
        "#60=IFCCIRCLE(#13,500.);\n#43=IFCSWEPTDISKSOLID(#60,14.5,$,$,$);",
    );
    for model in [hollow, closed] {
        let sources = RetainedSources::swept_disks(model.as_bytes(), None);
        assert!(sources.admitted.is_empty());
        assert_eq!(sources.refused.len(), 1);
        assert_eq!(sources.refused[0].product_id, None);
        assert!(
            matches!(
                sources.refused[0].refusal,
                RetainedSourceRefusal::Source(RetainedRefusal::UnsupportedSource(_))
            ),
            "{:?}",
            sources.refused[0]
        );
    }
    let boolean = replaced(
        "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));",
        "#1001=IFCBOOLEANRESULT(.DIFFERENCE.,#43,#43);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));",
    );
    let sources = RetainedSources::swept_disks(boolean.as_bytes(), None);
    assert!(sources.admitted.is_empty());
    assert!(!sources.refused.is_empty());
    assert!(sources
        .refused
        .iter()
        .all(|refused| refused.product_id == Some(50)
            && refused.refusal == RetainedSourceRefusal::EnclosingBooleanUnevaluated));
}

#[test]
fn scaled_occurrences_of_admitted_disks_are_refused_per_product() {
    let scale = |model: String| {
        let from = "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);";
        assert!(model.contains(from));
        model.replace(
            from,
            "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);",
        )
    };
    // The rational source's own line/arc status is inherited by every
    // occurrence and ignored; an occurrence-specific scale never is.
    for model in [scale(fixture()), scale(rational())] {
        let sources = RetainedSources::swept_disks(model.as_bytes(), None);
        assert!(sources.admitted.is_empty());
        assert_eq!(sources.refused.len(), 1);
        assert_eq!(sources.refused[0].product_id, Some(50));
        assert!(
            matches!(
                sources.refused[0].refusal,
                RetainedSourceRefusal::UnqualifiedOccurrenceTransform
                    | RetainedSourceRefusal::OccurrenceUnsupported(_)
            ),
            "{:?}",
            sources.refused[0]
        );
    }
}
