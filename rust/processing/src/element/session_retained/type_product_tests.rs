// SPDX-License-Identifier: MPL-2.0
//! #7955 M9: exact scheduling is the sole candidate and type-map classifier.
use crate::element::{plan_type_geometry, TypeGeometryMode};
use crate::processor::entry_points::{canonical_element_jobs, canonical_type_maps};
use ifc_lite_core::SourceBundle;
use super::super::session_tests::SOURCE;

#[test]
fn issue_7955_m9_candidates_follow_exact_order_once_per_type() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let ids: Vec<_> = canonical_element_jobs(&source).into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids, [10, 20, 50, 60]);
    assert_eq!(canonical_type_maps(&source)[&60],
        plan_type_geometry(&[61, 71], &Default::default(), false, TypeGeometryMode::SuppressInstanced));
    let source = SourceBundle::new(include_bytes!("../../../../geometry/tests/fixtures/issue_6446_mapped_source_frames.ifc").to_vec());
    assert_eq!(canonical_element_jobs(&source).into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
        [70, 75, 80, 85, 90, 95, 105]);
    assert_eq!(canonical_type_maps(&source)[&105], [(101, 1), (103, 1), (108, 1)]);
}

#[test]
fn issue_7955_m9_instanced_types_and_referenced_maps_are_not_candidates() {
    for (record, expected) in [
        ("#101=IFCRELDEFINESBYTYPE('r',$,$,$,(#10),#60);", vec![]),
        ("#101=IFCMAPPEDITEM(#61,#102);#102=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);", vec![(71, 1)]),
        ("#101=IFCMAPPEDITEM(#61,#102);#103=IFCMAPPEDITEM(#71,#102);#102=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);", vec![]),
    ] {
        let text = SOURCE.replace("ENDSEC;END-ISO", &format!("{record}ENDSEC;END-ISO"));
        let source = SourceBundle::new(text.into_bytes());
        assert_eq!(canonical_type_maps(&source).remove(&60).unwrap_or_default(), expected);
        assert_eq!(canonical_element_jobs(&source).iter().any(|(id, _)| *id == 60), !expected.is_empty());
    }
}

#[path = "../../../../geometry/tests/support/m9_type_fixtures.rs"]
mod fixtures;

#[test]
fn issue_7955_m9_curve_only_exact_emits_nothing_and_is_not_a_candidate() {
    let text = fixtures::curves();
    let exact = crate::process_geometry(text.as_bytes());
    assert!(exact.meshes.is_empty(), "Annotation2D curve-only type must have no exact mesh");
    let source = SourceBundle::new(text.into_bytes());
    assert!(canonical_element_jobs(&source).is_empty());
    assert!(canonical_type_maps(&source).is_empty());
    // A Body map sharing the same type keeps the complete map list: unsupported
    // content is still refused atomically rather than publishing a subset.
    let mixed = fixtures::insert(&fixtures::curves().replace("(#10),$,$,.NOTDEFINED.",
        "(#10,#41),$,$,.NOTDEFINED."),
        "#40=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#8));#41=IFCREPRESENTATIONMAP(#2,#40);");
    let source = SourceBundle::new(mixed.into_bytes());
    assert_eq!(canonical_type_maps(&source)[&20], [(10, 1), (41, 1)]);
}
