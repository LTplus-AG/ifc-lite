// SPDX-License-Identifier: MPL-2.0
//! Retained authored-extrusion requests built from a model (F2b, #7955):
//! worker/revision/source identity, f64 frames, strict refusal families and
//! the explicit retained -> display boundary.

use ifc_lite_geometry::document::{
    DocumentError, RegionQualification, RetainedCompletion, RetainedDisplayContract,
    RetainedRefusal, RetainedTessellation,
};
use ifc_lite_processing::retained_requests::{RetainedExtrusionRefusal, RetainedExtrusionSources};
use std::collections::HashSet;

/// The fixture's 64 proxies, #31 + 7k, all mapping the one extrusion #12.
const PRODUCTS: usize = 64;

fn products() -> Vec<u32> {
    (0..PRODUCTS as u32).map(|k| 31 + 7 * k).collect()
}

fn fixture() -> String {
    std::fs::read_to_string("../geometry/tests/fixtures/mapped_instances_synthetic.ifc").unwrap()
}

fn replaced(from: &str, to: &str) -> String {
    let model = fixture();
    assert!(model.contains(from), "fixture lost {from}");
    model.replace(from, to)
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

#[test]
fn mapped_rectangle_is_one_retained_source_with_every_occurrence() {
    let sources = RetainedExtrusionSources::extract(fixture().as_bytes(), None);
    assert!(sources.diagnostics.is_empty(), "{:?}", sources.diagnostics);
    assert!(sources.refused.is_empty(), "{:?}", sources.refused);
    assert_eq!(sources.admitted.len(), 1);
    let source = &sources.admitted[0];
    assert_eq!(source.key().solid_id, 12);
    assert_eq!(source.key().model_sha256, sources.model_sha256);
    assert_eq!(source.qualification(), Ok(RegionQualification::Rectangle));
    let recipe = source
        .document()
        .retained_extrusion(source.definition())
        .unwrap();
    assert!(
        recipe.source.source.is_some(),
        "original records are captured"
    );
    let ids: Vec<_> = source.occurrences().iter().map(|o| o.product_id).collect();
    assert_eq!(ids, products());
    // Evaluation origin is the profile's first corner (-0.5, -0.5); product
    // 38 sits at (3, 2, 0). Row-major translation column, in f64 metres.
    let frame = source.occurrences()[1].world_from_evaluation;
    assert_eq!([frame[3], frame[7], frame[11]], [2.5, 1.5, 0.0]);
    assert_eq!([frame[0], frame[5], frame[10], frame[15]], [1.0; 4]);

    assert_eq!(source.prepare(0).unwrap_err(), RetainedRefusal::WrongWorker);
    let request = source.prepare(4).unwrap();
    assert_eq!(
        (request.worker_incarnation(), request.definition()),
        (4, source.definition())
    );
    let payload = request.payload();
    assert_eq!((payload.format, payload.loops, payload.segments), (1, 1, 4));
    assert_eq!(payload.bytes.len(), 48 + 8 + 4 * 104);
    assert_eq!(
        [
            word(&payload.bytes, 0),
            word(&payload.bytes, 4),
            word(&payload.bytes, 8)
        ],
        [1, 1, 4]
    );
}

#[test]
fn product_filter_limits_occurrences_not_the_source() {
    let ids = HashSet::from([38]);
    let sources = RetainedExtrusionSources::extract(fixture().as_bytes(), Some(&ids));
    assert_eq!(sources.admitted.len(), 1);
    assert_eq!(sources.admitted[0].occurrences().len(), 1);
    let none = RetainedExtrusionSources::extract(fixture().as_bytes(), Some(&HashSet::new()));
    assert!(none.admitted.is_empty() && none.refused.is_empty());
}

#[test]
fn published_display_is_one_flat_definition_placed_at_every_occurrence() {
    let mut sources = RetainedExtrusionSources::extract(fixture().as_bytes(), None);
    let source = &mut sources.admitted[0];
    let request = source.prepare(4).unwrap();
    let (from, to) = (
        request.payload().source_from_evaluation,
        request.payload().evaluation_from_source,
    );
    let completion = RetainedCompletion::new(
        request,
        RetainedTessellation {
            positions: vec![0., 0., 0., 1., 0., 0., 0., 1., 0.],
            indices: vec![0, 1, 2],
            flat_corner_normals: vec![0., 0., 1., 0., 0., 1., 0., 0., 1.],
            revision_local_faces: vec![0],
            source_face_count: 1,
            boundary_edges: 0,
            spine_edges: 0,
        },
        from,
        to,
    );
    assert_eq!(
        source
            .publish_display(
                &completion,
                5,
                RetainedDisplayContract::UnstyledFlatSourceOnly
            )
            .unwrap_err(),
        RetainedRefusal::WrongWorker
    );
    assert_eq!(
        source
            .publish_display(&completion, 4, RetainedDisplayContract::IfcAppearance)
            .unwrap_err(),
        RetainedRefusal::IfcAppearanceUnavailable
    );
    let revision = source.document().revision();
    let published = source
        .publish_display(
            &completion,
            4,
            RetainedDisplayContract::UnstyledFlatSourceOnly,
        )
        .unwrap();
    assert_eq!(source.document().revision(), revision + 1 + PRODUCTS as u64);
    let document = source.document();
    assert_eq!(document.source_entity_id(published.definition), Ok(12));
    assert_eq!(
        document.mesh(published.definition).unwrap().indices,
        [0, 1, 2]
    );
    assert_eq!(published.occurrences.len(), PRODUCTS);
    for ((product_id, handle), expected) in published.occurrences.iter().zip(source.occurrences()) {
        let occurrence = document.occurrence(*handle).unwrap();
        assert_eq!(
            (occurrence.source_entity_id, *product_id),
            (expected.product_id, expected.product_id)
        );
        assert_eq!(occurrence.local_to_model, expected.world_from_evaluation);
    }
    // The authored source stays retained beside its display; the packet is spent.
    assert!(document.retained_extrusion(source.definition()).is_ok());
    assert_eq!(
        source
            .publish_display(
                &completion,
                4,
                RetainedDisplayContract::UnstyledFlatSourceOnly
            )
            .unwrap_err(),
        RetainedRefusal::Document(DocumentError::StaleRevision)
    );
}

#[test]
fn boolean_operands_are_refused_per_occurrence_and_not_admitted() {
    let model = replaced(
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
        "#1001=IFCBOOLEANRESULT(.UNION.,#12,#12);\n#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#1001));",
    );
    let sources = RetainedExtrusionSources::extract(model.as_bytes(), None);
    assert!(sources.admitted.is_empty());
    assert_eq!(sources.refused.len(), 2 * PRODUCTS);
    assert!(sources
        .refused
        .iter()
        .all(|refused| refused.product_id.is_some()
            && refused.refusal == RetainedExtrusionRefusal::EnclosingBooleanUnevaluated));
}

#[test]
fn mirrored_and_scaled_occurrences_are_refused_beside_admitted_ones() {
    let mirrored = replaced(
        "#25=IFCMAPPEDITEM(#16,#17);",
        "#1003=IFCDIRECTION((0.,-1.,0.));\n#1004=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#1003,#1,$,$);\n#25=IFCMAPPEDITEM(#16,#1004);",
    );
    let scaled = replaced(
        "#32=IFCMAPPEDITEM(#16,#17);",
        "#1004=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#1,$,$,2.,1.);\n#32=IFCMAPPEDITEM(#16,#1004);",
    );
    for (model, product, expected) in [
        (mirrored, 31, "UnqualifiedOccurrenceTransform"),
        (scaled, 38, "UnqualifiedOccurrenceTransform"),
    ] {
        let sources = RetainedExtrusionSources::extract(model.as_bytes(), None);
        assert_eq!(sources.refused.len(), 1, "{:?}", sources.refused);
        assert_eq!(sources.refused[0].product_id, Some(product));
        assert!(
            format!("{:?}", sources.refused[0].refusal).starts_with(expected),
            "{:?}",
            sources.refused[0]
        );
        let admitted: Vec<_> = sources.admitted[0]
            .occurrences()
            .iter()
            .map(|o| o.product_id)
            .collect();
        assert_eq!(admitted.len(), PRODUCTS - 1);
        assert!(!admitted.contains(&product));
    }
}

#[test]
fn unsupported_profile_refuses_the_source_without_a_mesh() {
    let model = replaced(
        "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);",
        "#8=IFCISHAPEPROFILEDEF(.AREA.,$,#7,1.0,1.0,0.1,0.1,$,$,$);",
    );
    let sources = RetainedExtrusionSources::extract(model.as_bytes(), None);
    assert!(sources.admitted.is_empty());
    assert_eq!(sources.refused.len(), 1);
    assert_eq!(sources.refused[0].product_id, None);
    assert!(
        matches!(
            sources.refused[0].refusal,
            RetainedExtrusionRefusal::Source(RetainedRefusal::UnsupportedSource(_))
        ),
        "{:?}",
        sources.refused[0]
    );
}
