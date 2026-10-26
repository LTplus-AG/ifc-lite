// SPDX-License-Identifier: MPL-2.0
//! #7955 R1: malformed required mapping inputs refuse the entire retained plan.
use super::*;
use crate::program::retained::failure::{MappingReason, OriginCause, OriginFailure};
use std::sync::Arc;

#[derive(Clone, Copy)]
enum ExpectedCause { Mapping(MappingReason), Missing(u32), Malformed(u32), Unrepresentable(u32) }

fn origin(error: RetainedFailure) -> Arc<OriginFailure> {
    let RetainedFailure::Origin(handle) = error else { panic!("B2a typed origin required: {error:?}") };
    handle.origin().expect("B2a owned origin survives completion")
}

fn assert_origin(failure: &OriginFailure, site: FailureSite, entity: u32, expected: ExpectedCause) {
    assert_eq!(failure.site, site, "B2a mapped input site");
    assert_eq!(failure.entity, Some(entity), "B2a reached input identity");
    match expected {
        ExpectedCause::Mapping(reason) => assert!(matches!(failure.cause,
            OriginCause::Mapping(actual) if actual == reason), "B2a predicate cause: {:?}", failure.cause),
        ExpectedCause::Missing(id) => assert!(matches!(&failure.cause,
            OriginCause::Core(ifc_lite_core::Error::ParseError { position: 0, message })
            if message == &format!("Entity #{id} not found")), "B2a actual missing-index payload: {:?}", failure.cause),
        ExpectedCause::Unrepresentable(id) => assert!(matches!(failure.cause,
            OriginCause::Core(ifc_lite_core::Error::UnrepresentableReal(actual)) if actual == id),
            "B2a actual strict decoder payload: {:?}", failure.cause),
        ExpectedCause::Malformed(id) => assert!(matches!(failure.cause,
            OriginCause::Core(ifc_lite_core::Error::MalformedRecord(actual)) if actual == id),
            "B2a actual leaf payload: {:?}", failure.cause),
    }
}

fn two_occurrences(later: &str, extra: &str) -> String {
    mapping_tests::mapped()
        .replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#93)")
        .replace("ENDSEC;END-ISO", &format!("#93=IFCMAPPEDITEM({later});{extra}ENDSEC;END-ISO"))
}

fn assert_late_refusal(bytes: &str, site: FailureSite, entity_id: u32, cause: ExpectedCause) {
    // The type-map root contains the same two nested mapped occurrences.
    for mode in 0..3 {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = match mode {
            0 => RetainedProgram::product_parts(&entity, contract()),
            1 => RetainedProgram::product_submeshes(&entity, true, None, contract()),
            _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
        };
        let selection = program.selection().unwrap().clone();
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1, "first source was admitted before late refusal, mode {mode}");
        assert!(matches!(operations[0].value().definition(),
            LogicalRetainedDefinition::Source { source_id: 113, .. }));
        let cached = selection.cached(&decoder, &router, 81).unwrap().unwrap();
        assert_eq!(cached.len(), 1, "earlier source really is cached");
        assert_eq!(cached[0].definition(), operations[0].value().definition());
        let recorded = selection.failure_handle().origin().expect("origin before completion");
        let error = if mode == 2 {
            program.finish_type_map(60, 1, [1.; 4]).unwrap_err()
        } else { program.finish().unwrap_err() };
        let failure = origin(error);
        assert!(Arc::ptr_eq(&recorded, &failure));
        assert_origin(&failure, site, entity_id, cause);
    }
}

#[test]
fn h2_r1_cached_source_requires_each_mapping_target() {
    for target in ["$", "1.0", "#4"] {
        let (id, reason) = if target == "#4" { (4, MappingReason::Category) }
            else { (93, MappingReason::ReferenceRequired) };
        assert_late_refusal(&two_occurrences(&format!("#81,{target}"), ""),
            FailureSite::MappingTarget, id, ExpectedCause::Mapping(reason));
    }
    assert_late_refusal(&two_occurrences("#81", ""), FailureSite::MappingTarget, 93,
        ExpectedCause::Mapping(MappingReason::ReferenceRequired));
}

#[test]
fn h2_r1_mapping_source_must_be_a_representation_map_reference() {
    for source in ["$", "1.0", "#82"] {
        let (id, reason) = if source == "#82" { (82, MappingReason::Category) }
            else { (93, MappingReason::ReferenceRequired) };
        assert_late_refusal(&two_occurrences(&format!("{source},#82"), ""),
            FailureSite::MappingSource, id, ExpectedCause::Mapping(reason));
    }
}

#[test]
fn h2_r1_later_mapped_items_must_be_a_readable_reference_list() {
    for items in ["", ",$", ",1.0", ",()", ",(#113,$)", ",(#113,1.0)"] {
        let extra = format!("#94=IFCREPRESENTATIONMAP(#5,#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid'{items});");
        let reason = if items.starts_with(",(") && items != ",()" { MappingReason::NonReferenceMember }
            else { MappingReason::ListRequired };
        assert_late_refusal(&two_occurrences("#94,#82", &extra), FailureSite::MappingItems, 95,
            ExpectedCause::Mapping(reason));
    }
}

#[test]
fn h2_r1_explicit_empty_mapped_source_refuses_like_a_direct_one() {
    // `Items` is SET [1:?]. An explicit () under an IfcMappedItem refuses the
    // plan, as the same list does on a representation the product references
    // directly, and does not discard or publish the earlier admitted solid.
    let bytes = two_occurrences("#94,#82",
        "#94=IFCREPRESENTATIONMAP(#5,#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',());")
        .replace("#84,1.,$", "#4,1.,$");
    assert_late_refusal(&bytes, FailureSite::MappingItems, 95,
        ExpectedCause::Mapping(MappingReason::ListRequired));
}

// #7955 S2 review R1: a selected later map cannot recover malformed authored
// semantics into an otherwise valid matrix or publish the earlier contribution.
#[test]
fn s2_r1_later_mapping_origin_is_required_before_exact_recovery() {
    for origin in ["$", "*", "1.", "#4"] {
        let extra = format!("#94=IFCREPRESENTATIONMAP({origin},#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));");
        let (id, reason) = if origin == "#4" { (4, MappingReason::Category) }
            else { (94, MappingReason::ReferenceRequired) };
        assert_late_refusal(&two_occurrences("#94,#82", &extra), FailureSite::MappingOrigin, id,
            ExpectedCause::Mapping(reason));
    }
}

#[test]
fn s2_r1_later_mapped_representation_category_precedes_items_access() {
    for category in ["IFCWALL", "UNKNOWNREPRESENTATION"] {
        let extra = format!("#94=IFCREPRESENTATIONMAP(#5,#95);#95={category}(#2,'Body','SweptSolid',(#113));");
        assert_late_refusal(&two_occurrences("#94,#82", &extra), FailureSite::MappedRepresentation, 95,
            ExpectedCause::Mapping(MappingReason::Category));
    }
}

#[test]
fn s2_r1_later_explicit_scale_tokens_cannot_default_even_on_cache_hits() {
    // Each slot is independently reached; earlier #81 is already cached.
    for token in ["'bad'", "#4", "*", "(1.)", "1.E999", "-1.E999"] {
        for (attribute, target) in [
            (3, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,{token},$)")),
            (3, format!("IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#84,{token})")),
            (4, format!("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,$,#84,1.,{token})")),
            (5, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,$,{token},1.)")),
            (6, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,$,1.,{token})")),
        ] {
            assert_late_refusal(&two_occurrences("#81,#96", &format!("#96={target};")),
                FailureSite::MappingScale, 96, ExpectedCause::Mapping(MappingReason::FiniteScale { attribute }));
        }
    }
}

#[test]
fn s2_r1_optional_scales_keep_canonical_defaults_and_supported_origins() {
    for (target, expected_scale) in [
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,$,$)", 1.),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84)", 1.),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,2.,$,$,$)", 2.),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,2.,$)", 2.),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,$,#84,2.,$)", 2.),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,$,#84,2.)", 2.),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1,$)", 1.),
    ] {
        for origin in ["IFCAXIS2PLACEMENT3D(#4,$,$)", "IFCAXIS2PLACEMENT2D(#4,$)"] {
            let bytes = mapping_tests::mapped()
                .replace("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.,$)", target)
                .replace("#81=IFCREPRESENTATIONMAP(#5,#83)", "#81=IFCREPRESENTATIONMAP(#94,#83)")
                .replace("ENDSEC;END-ISO", &format!("#94={origin};ENDSEC;END-ISO"));
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let mut decoder = source.decoder();
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            let entity = decoder.decode_by_id(10).unwrap();
            let mut program = RetainedProgram::product_parts(&entity, contract());
            let operations = drive(&mut program, &router, &mut decoder);
            assert!(operations[0].construction().is_some());
            let plan = program.finish().unwrap();
            assert_eq!(plan.values.len(), 1);
            if expected_scale == 1. {
                assert_eq!(operations.len(), 1);
                let frame = plan.values[0].world_from_source().unwrap();
                assert_eq!([frame[12], frame[13], frame[14]], [12., 24., 36.]);
            } else {
                assert_eq!(operations.len(), 2);
                let RetainedOperationKind::Affine { matrix, .. } = operations[1].kind() else { panic!("affine") };
                assert_eq!([matrix[0], matrix[5], matrix[10]], [expected_scale; 3]);
                assert_eq!([matrix[12], matrix[13], matrix[14]], [0., 0., 6.]);
            }
        }
    }
}

#[path = "mapping_direction_tests.rs"]
mod directions;

#[path = "mapping_origin_tests.rs"]
mod origins;
