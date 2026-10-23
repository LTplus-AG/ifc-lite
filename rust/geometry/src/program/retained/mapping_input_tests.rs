// SPDX-License-Identifier: MPL-2.0
//! #7955 R1: malformed required mapping inputs refuse the entire retained plan.
use super::*;

fn two_occurrences(later: &str, extra: &str) -> String {
    mapping_tests::mapped()
        .replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#93)")
        .replace("ENDSEC;END-ISO", &format!("#93=IFCMAPPEDITEM({later});{extra}ENDSEC;END-ISO"))
}

fn assert_late_refusal(bytes: &str, diagnostic: &str) {
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
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1, "first source was admitted before late refusal, mode {mode}");
        assert!(matches!(operations[0].value().definition(),
            LogicalRetainedDefinition::Source { source_id: 113, .. }));
        let error = if mode == 2 {
            program.finish_type_map(60, 1, [1.; 4]).unwrap_err()
        } else { program.finish().unwrap_err() };
        assert!(error.to_string().contains(diagnostic), "mode {mode}: {error}");
    }
}

#[test]
fn h2_r1_cached_source_requires_each_mapping_target() {
    for target in ["$", "1.0", "#4"] {
        assert_late_refusal(&two_occurrences(&format!("#81,{target}"), ""), "MappingTarget");
    }
    assert_late_refusal(&two_occurrences("#81", ""), "MappingTarget");
}

#[test]
fn h2_r1_mapping_source_must_be_a_representation_map_reference() {
    for source in ["$", "1.0", "#82"] {
        assert_late_refusal(&two_occurrences(&format!("{source},#82"), ""), "MappingSource");
    }
}

#[test]
fn h2_r1_later_mapped_items_must_be_a_readable_reference_list() {
    for items in ["", ",$", ",1.0", ",(#113,$)", ",(#113,1.0)"] {
        let extra = format!("#94=IFCREPRESENTATIONMAP(#5,#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid'{items});");
        assert_late_refusal(&two_occurrences("#94,#82", &extra), "Items");
    }
}

#[test]
fn h2_r1_identity_target_and_explicit_empty_source_are_admitted() {
    // An authored empty source is an empty contribution, not authenticated
    // whole-product subtraction. It must not discard the earlier solid.
    let bytes = two_occurrences("#94,#82",
        "#94=IFCREPRESENTATIONMAP(#5,#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',());")
        .replace("#84,1.,$", "#4,1.,$");
    for mode in 0..3 {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = match mode {
            0 => RetainedProgram::product_parts(&entity, contract()),
            1 => RetainedProgram::product_submeshes(&entity, true, None, contract()),
            _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
        };
        assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
        let plan = if mode == 2 { program.finish_type_map(60, 1, [1.; 4]).unwrap() }
            else { program.finish().unwrap() };
        assert_eq!(plan.values.len(), 1);
        let world = plan.values[0].world_from_source().unwrap();
        assert_eq!([world[12], world[13], world[14]], [10., 20., 30.]);
    }
}
