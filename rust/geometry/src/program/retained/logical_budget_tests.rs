// SPDX-License-Identifier: MPL-2.0
//! #7781: retained validation is inside logical admission, including cache hits.
use super::*;
use crate::program::mapping::{MappingControl, MappingOutput, Reached};

fn product<'a>(entity: &'a DecodedEntity, limit: u32) -> RetainedProgram<'a> {
    let mut program = RetainedProgram::product_parts(entity, contract());
    let selection = program.selection().unwrap().clone();
    geometry(&mut program).control =
        Control::Product(ProductControl::retained(entity, selection).with_logical_limit(limit));
    program
}

fn geometry<'p, 'a>(program: &'p mut RetainedProgram<'a>) -> &'p mut GeometryProgram<'a> {
    let RetainedInner::Geometry(inner) = &mut program.inner else {
        panic!("geometry program")
    };
    inner
}

fn finish(program: RetainedProgram<'_>) -> crate::Result<Output> {
    let RetainedInner::Geometry(inner) = program.inner else {
        panic!("geometry program")
    };
    inner.finish_output()
}

fn type_map(map: DecodedEntity, limit: u32) -> RetainedProgram<'static> {
    let mut program = RetainedProgram::type_map(map, None, contract());
    let Control::Mapping(control) = &mut geometry(&mut program).control else {
        panic!("type map")
    };
    control.set_logical_limit(limit);
    program
}

fn occurrence<'a>(
    item: &'a DecodedEntity,
    selection: RetainedSelection,
    limit: u32,
) -> RetainedProgram<'a> {
    let mut control = MappingControl::retained_occurrence(Reached::Root(item), selection);
    control.set_logical_limit(limit);
    RetainedProgram {
        inner: RetainedInner::Geometry(GeometryProgram::with_control(Control::Mapping(control))),
        cancelled: false,
        unsupported: false,
    }
}

/// #9102: only a repeated read pays, so `program` acts as if this walk had
/// already read representation `rep`'s Items.
fn repeating(mut program: RetainedProgram<'_>, rep: u32) -> RetainedProgram<'_> {
    let Control::Mapping(control) = &mut geometry(&mut program).control else {
        panic!("mapping program")
    };
    control.mark_seen(rep);
    program
}

#[test]
fn issue_7781_retained_product_admission_precedes_member_decode_and_dangling_reference() {
    // #9102: the root is listed twice. Its first read is free; the repeat pays
    // both members, which a one-member allowance refuses for the product.
    let bytes = SOURCE
        .replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)")
        .replace("($,$,(#12))", "($,$,(#12,#12))");
    for (limit, refused) in [(1, true), (2, false)] {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = product(&entity, limit);
        let operations = drive(&mut program, &router, &mut decoder);
        let result = program.finish();
        if refused {
            assert!(operations.is_empty());
            assert!(result.unwrap_err().to_string().contains("work budget"));
        } else {
            assert_eq!(result.unwrap().values.len(), 4);
        }
        assert!(router.take_unsupported_items().is_empty());
    }
    // A malformed member of a first read is the file's fault, not the budget's.
    for members in ["#999999,#13", "17,#13"] {
        let bytes = SOURCE.replace("'SweptSolid',(#13)", &format!("'SweptSolid',({members})"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = product(&entity, 0);
        assert!(drive(&mut program, &router, &mut decoder).is_empty());
        let error = program.finish().unwrap_err().to_string();
        assert!(!error.contains("work budget"), "{error}");
    }
}

#[test]
fn issue_7781_retained_skipped_representations_pay_before_strict_validation() {
    // #9102: the unselected Axis list is read twice. Even skipped, its repeat
    // pays both members before strict validation, which one cannot cover.
    let bytes = SOURCE.replace("($,$,(#12))", "($,$,(#12,#22,#22))").replace(
        "#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23))",
        "#22=IFCSHAPEREPRESENTATION(#2,'Axis','Curve3D',(#23,#23))",
    );
    for (limit, refused) in [(1, true), (2, false)] {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = product(&entity, limit);
        let operations = drive(&mut program, &router, &mut decoder);
        let result = program.finish();
        if refused {
            assert!(operations.is_empty());
            assert!(result.unwrap_err().to_string().contains("work budget"));
        } else {
            assert_eq!(result.unwrap().values.len(), 1, "only the Body is selected");
        }
    }
}

#[test]
fn issue_7781_retained_type_map_admission_precedes_member_decode_and_dangling_reference() {
    for members in ["#13,#13", "#999999,#13", "17,#13"] {
        let bytes = SOURCE.replace("'SweptSolid',(#13)", &format!("'SweptSolid',({members})"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let mut program = repeating(type_map(decoder.decode_by_id(61).unwrap(), 1), 12);
        assert!(drive(&mut program, &router, &mut decoder).is_empty());
        assert!(program
            .finish_type_map(60, 1, [1.; 4])
            .unwrap_err()
            .to_string()
            .contains("work budget"));
        assert!(decoder.get_cached(13).is_none());
        assert!(router.take_unsupported_items().is_empty());
    }
}

#[test]
fn issue_7781_retained_roots_reuse_exactly_admitted_members_and_preserve_placement() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    for mode in 0..2 {
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(SOURCE, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = if mode == 0 {
            product(&entity, 1)
        } else {
            type_map(decoder.decode_by_id(61).unwrap(), 1)
        };
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1);
        assert!(matches!(
            operations[0].value().definition(),
            LogicalRetainedDefinition::Source { source_id: 13, .. }
        ));
        let plan = if mode == 0 {
            program.finish()
        } else {
            program.finish_type_map(60, 1, [1.; 4])
        }
        .unwrap();
        assert_eq!(plan.values.len(), 1);
        let world = plan.values[0].world_from_source().unwrap();
        assert_eq!([world[12], world[13], world[14]], [10., 20., 30.]);
    }
}

#[test]
fn issue_7781_retained_warm_mapping_pays_items_once_per_attempt() {
    let bytes = mapping_tests::mapped().replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
    for limit in [1, 2] {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let mut program = type_map(decoder.decode_by_id(61).unwrap(), limit);
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(
            operations.len(),
            1,
            "second occurrence must reuse the real source cache"
        );
        assert!(program
            .selection()
            .unwrap()
            .cached(&decoder, &router, 81)
            .unwrap()
            .is_some());
        // Both occurrences pay an attempt, cached or not. The root and the
        // cold source are first reads (#9102); the warm occurrence pays one member.
        let result = program.finish_type_map(60, 1, [1.; 4]);
        if limit == 1 {
            assert!(result.unwrap_err().to_string().contains("work budget"));
        } else {
            let plan = result.unwrap();
            assert_eq!(plan.values.len(), 2);
            assert_eq!(plan.values[0].definition(), plan.values[1].definition());
            assert_ne!(plan.values[0].slot(), plan.values[1].slot());
            for value in plan.values {
                let world = value.world_from_source().unwrap();
                assert_eq!([world[12], world[13], world[14]], [12., 24., 36.]);
            }
        }
    }
}

#[test]
fn issue_7781_retained_cached_mapping_guards_members_even_with_a_populated_source_cache() {
    let bytes = mapping_tests::mapped();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut warm = RetainedProgram::product_parts(&entity, contract());
    assert_eq!(drive(&mut warm, &router, &mut decoder).len(), 1);
    let values = warm
        .selection()
        .unwrap()
        .cached(&decoder, &router, 81)
        .unwrap()
        .unwrap();
    warm.finish().unwrap();
    // Install actual constructed values in a fresh owner domain with cold
    // decoded members. Even a populated cache may not waive source validation,
    // including an adversarial list whose first member is dangling.
    for members in ["#113,#113", "#999999,#113", "17,#113"] {
        let bytes = bytes.replace("'SweptSolid',(#113)", &format!("'SweptSolid',({members})"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let item = decoder.decode_by_id(13).unwrap();
        let selection = RetainedSelection::new(contract(), next_program_id()).unwrap();
        selection.validate_owner(&decoder, &router).unwrap();
        selection.publish(81, &values).unwrap();
        assert!(selection.cached(&decoder, &router, 81).unwrap().is_some());
        // #9102: a repeated read of #83, as a second occurrence would be.
        let mut program = repeating(occurrence(&item, selection, 1), 83);
        assert!(drive(&mut program, &router, &mut decoder).is_empty());
        let error = finish(program).err().expect("complete refusal");
        assert!(error.to_string().contains("work budget"));
        assert!(decoder.get_cached(113).is_none());
        assert!(router.take_unsupported_items().is_empty());
    }
}

#[test]
fn issue_7781_retained_source_reply_debit_survives_foreign_rejection_without_double_charge() {
    let bytes = mapping_tests::mapped();
    for mode in 0..2 {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let foreign = GeometryRouter::with_units(&bytes, &mut decoder);
        let item = decoder.decode_by_id(13).unwrap();
        let mut program = if mode == 0 {
            type_map(decoder.decode_by_id(81).unwrap(), 1)
        } else {
            occurrence(
                &item,
                RetainedSelection::new(contract(), next_program_id()).unwrap(),
                1,
            )
        };
        let ticket = program.request().unwrap().unwrap();
        let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
        assert!(operations.is_empty());
        assert!(matches!(
            program.admit(ticket, &router, &mut decoder),
            Err(RetainedProgramError::AlreadyExecuted)
        ));
        let rejected = program.accept(reply, &foreign).expect_err("foreign owner");
        assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
        program
            .accept(rejected.reply, &router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
        assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
        let Output::Mapping(MappingOutput::Retained(values)) = finish(program).unwrap() else {
            panic!("retained output")
        };
        assert_eq!(values.len(), 1);
    }
}

#[test]
fn issue_7781_retained_product_shares_root_and_nested_items_allowance() {
    // #9102: only repeats pay. The second #12 repeats one root member and its
    // #13 repeats #83's one member: two from one shared allowance.
    let bytes = mapping_tests::mapped().replace("($,$,(#12))", "($,$,(#12,#12))");
    for (limit, refused) in [(1, true), (2, false)] {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = product(&entity, limit);
        let operations = drive(&mut program, &router, &mut decoder);
        let result = program.finish();
        if refused {
            assert!(operations.is_empty());
            assert!(result.unwrap_err().to_string().contains("work budget"));
            continue;
        }
        assert_eq!(operations.len(), 1);
        let plan = result.unwrap();
        assert_eq!(plan.values.len(), 2);
        for value in plan.values {
            let world = value.world_from_source().unwrap();
            assert_eq!([world[12], world[13], world[14]], [12., 24., 36.]);
        }
    }
}
