// SPDX-License-Identifier: MPL-2.0
//! #7955 B2a: actual logical controllers, no numerical receipt or SDK claim.
use super::*;

fn finish(program: RetainedProgram<'_>, mode: usize) -> std::result::Result<RetainedProductPlan, RetainedFailure> {
    if mode == 2 { program.finish_type_map(60, 1, [1.; 4]) } else { program.finish() }
}

fn cached_run(bytes: &str, mode: usize) -> std::result::Result<RetainedProductPlan, RetainedFailure> {
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = match mode {
        0 => RetainedProgram::product_parts(&entity, contract()),
        1 => RetainedProgram::product_submeshes(&entity, true, None, contract()),
        _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
    };
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 1, "earlier contribution is actually admitted");
    assert!(matches!(operations[0].value().definition(), LogicalRetainedDefinition::Source { source_id: 113, .. }));
    let cached = program.selection().unwrap().cached(&decoder, &router, 81).unwrap().unwrap();
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].definition(), operations[0].value().definition());
    finish(program, mode)
}

#[test]
fn issue_7955_b2a_cached_target_action_refuses_whole_plan() {
    let bytes = two_occurrences("#81,$", "");
    for mode in 0..3 {
        assert!(cached_run(&bytes, mode).is_err(), "B2a mandatory target must refuse whole plan");
    }
}

#[test]
fn issue_7955_b2a_cached_target_report_preserves_reached_origin() {
    for mode in 0..3 {
        let failure = origin(cached_run(&two_occurrences("#81,$", ""), mode).unwrap_err());
        assert!(matches!(failure.cause, OriginCause::Mapping(MappingReason::ReferenceRequired)),
            "B2a cached target must preserve ReferenceRequired");
        assert_eq!(failure.site, FailureSite::MappingTarget);
        assert_eq!(failure.entity, Some(93));
    }
}

#[test]
fn issue_7955_b2a_missing_references_keep_actual_core_and_reached_id() {
    for (later, extra, site) in [
        ("#999999,#82", "", FailureSite::MappingSource),
        ("#81,#999999", "", FailureSite::MappingTarget),
        ("#94,#82", "#94=IFCREPRESENTATIONMAP(#999999,#83);", FailureSite::MappingOrigin),
        ("#94,#82", "#94=IFCREPRESENTATIONMAP(#5,#999999);", FailureSite::MappedRepresentation),
        ("#94,#82", "#94=IFCREPRESENTATIONMAP(#5,#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113,#999999));", FailureSite::MappingItems),
    ] {
        assert_late_refusal(&two_occurrences(later, extra), site, 999999, ExpectedCause::Missing(999999));
    }
    for representation in ["$", "*", "1."] {
        let extra = format!("#94=IFCREPRESENTATIONMAP(#5,{representation});");
        assert_late_refusal(&two_occurrences("#94,#82", &extra), FailureSite::MappedRepresentation, 94,
            ExpectedCause::Mapping(MappingReason::ReferenceRequired));
    }
}

#[test]
fn issue_7955_b2a_direct_type_map_entry_records_before_construction() {
    for (root, map, representation, site, id, cause) in [
        (4, "#7,#12", "(#13)", FailureSite::MappingSource, 4, ExpectedCause::Mapping(MappingReason::Category)),
        (61, "#7,$", "(#13)", FailureSite::MappedRepresentation, 61, ExpectedCause::Mapping(MappingReason::ReferenceRequired)),
        (61, "#7,#4", "(#13)", FailureSite::MappedRepresentation, 4, ExpectedCause::Mapping(MappingReason::Category)),
        (61, "#7,#999999", "(#13)", FailureSite::MappedRepresentation, 999999, ExpectedCause::Missing(999999)),
        (61, "#7,#12", "$", FailureSite::MappingItems, 12, ExpectedCause::Mapping(MappingReason::ListRequired)),
        (61, "#7,#12", "(#13,$)", FailureSite::MappingItems, 12, ExpectedCause::Mapping(MappingReason::NonReferenceMember)),
        (61, "#7,#12", "(#13,#999999)", FailureSite::MappingItems, 999999, ExpectedCause::Missing(999999)),
    ] {
        let bytes = SOURCE.replace("#61=IFCREPRESENTATIONMAP(#7,#12)", &format!("#61=IFCREPRESENTATIONMAP({map})"))
            .replace("'SweptSolid',(#13)", &format!("'SweptSolid',{representation}"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let mut program = RetainedProgram::type_map(decoder.decode_by_id(root).unwrap(), None, contract());
        assert!(drive(&mut program, &router, &mut decoder).is_empty());
        let recorded = program.selection().unwrap().failure_handle().origin().expect("direct entry records origin");
        let failure = origin(program.finish_type_map(60, 1, [1.; 4]).unwrap_err());
        assert!(Arc::ptr_eq(&recorded, &failure));
        assert_origin(&failure, site, id, cause);
    }
}

#[test]
fn issue_7955_b2a_late_type_origin_reports_after_construction() {
    for (map, extra, id, cause) in [
        ("$,#12", "", 61, ExpectedCause::Mapping(MappingReason::ReferenceRequired)),
        ("*,#12", "", 61, ExpectedCause::Mapping(MappingReason::ReferenceRequired)),
        ("1.,#12", "", 61, ExpectedCause::Mapping(MappingReason::ReferenceRequired)),
        ("#4,#12", "", 4, ExpectedCause::Mapping(MappingReason::Category)),
        ("#96,#12", "#96=IFCAXIS2PLACEMENT2D(#4,$);", 96, ExpectedCause::Mapping(MappingReason::Category)),
        ("#999999,#12", "", 999999, ExpectedCause::Missing(999999)),
    ] {
        let bytes = SOURCE.replace("#61=IFCREPRESENTATIONMAP(#7,#12)", &format!("#61=IFCREPRESENTATIONMAP({map})"))
            .replace("ENDSEC;END-ISO", &format!("{extra}ENDSEC;END-ISO"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let mut program = RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1, "B2a type origin remains late");
        assert!(matches!(operations[0].value().definition(), LogicalRetainedDefinition::Source { source_id: 13, .. }));
        let failure = origin(program.finish_type_map(60, 1, [1.; 4]).unwrap_err());
        assert_eq!(failure.site, FailureSite::MappingOrigin, "B2a late type origin must preserve site");
        assert_origin(&failure, FailureSite::MappingOrigin, id, cause);
    }
}

#[test]
fn issue_7955_b2a_source_error_reply_remains_owned_until_acceptance() {
    for mode in 0..3 {
        let bytes = two_occurrences("#81,$", "");
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let foreign = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = match mode {
            0 => RetainedProgram::product_parts(&entity, contract()),
            1 => RetainedProgram::product_submeshes(&entity, true, None, contract()),
            _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
        };
        let mut reached = false;
        for _ in 0..100 {
            let ticket = program.request().unwrap().expect("mapping refusal must be reached");
            let (reply, _) = program.admit(ticket, &router, &mut decoder).unwrap();
            if let Some(recorded) = program.selection().unwrap().failure_handle().origin() {
                let rejected = program.accept(reply, &foreign).err().unwrap();
                assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
                assert_eq!(rejected.reply.0.request, ticket.0);
                program.accept(rejected.reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
                assert!(program.inner.pending.is_none(), "error reply consumed exactly once");
                assert!(drive(&mut program, &router, &mut decoder).is_empty());
                let failure = origin(finish(program, mode).unwrap_err());
                assert!(Arc::ptr_eq(&recorded, &failure));
                assert_origin(&failure, FailureSite::MappingTarget, 93,
                    ExpectedCause::Mapping(MappingReason::ReferenceRequired));
                reached = true;
                break;
            }
            program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
        }
        assert!(reached, "bounded controller reaches owned refusal reply");
    }
}

#[test]
fn issue_7955_b2a_strict_decoder_payloads_are_not_relabelled_as_predicate_failures() {
    for (extra, site, id) in [
        ("#96=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.E999,$);", FailureSite::MappingTarget, 96),
        ("#96=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#102,$,#84,1.,$);#102=IFCDIRECTION((1.E999,0.,0.));", FailureSite::MappingDirection, 102),
    ] {
        for mode in 0..3 {
            let bytes = two_occurrences("#81,#96", extra);
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let mut decoder = source.decoder().with_strict_reals();
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            let entity = decoder.decode_by_id(10).unwrap();
            let mut program = match mode {
                0 => RetainedProgram::product_parts(&entity, contract()),
                1 => RetainedProgram::product_submeshes(&entity, true, None, contract()),
                _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
            };
            assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
            let failure = origin(finish(program, mode).unwrap_err());
            assert_origin(&failure, site, id, ExpectedCause::Unrepresentable(id));
        }
    }
}

#[path = "mapping_origin_lifetime_tests.rs"]
mod lifetime;
